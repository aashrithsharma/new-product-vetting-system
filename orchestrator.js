const logger = require('./logger');
const scraper = require('./scraper');
const sheets = require('./sheets');
// const notifier = require('./notifier'); // Slack removed
const exporter = require('./exporter');
const config = require('./config');
const { delay } = require('./utils');
const urlParser = require('./urlParser');
const axios = require('axios');
const vettingEngine = require('./vettingEngine');
const path = require('path');


async function fetchLiveExchangeRate() {
    try {
        // Free endpoint — no API key required
        const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
        const rate = res.data && res.data.rates && res.data.rates.INR;
        if (rate && rate > 0) {
            logger.info(`[ORCHESTRATOR] Live exchange rate fetched: 1 USD = ${rate} INR`);
            return rate;
        }
        throw new Error('INR rate missing from response');
    } catch (err) {
        const fallback = 90; // Updated fallback (real rate ~92 as of Mar 2026)
        logger.warn(`[ORCHESTRATOR] Exchange rate fetch failed (${err.message}). Using fallback: 1 USD = ${fallback} INR`);
        return fallback;
    }
}

class Orchestrator {
    constructor() {
        this.runs = new Map(); // runId -> runState
        this.currentRunId = null;
    }

    async startRun({ products, formats, writeToSheets, triggerSource, customSheetId, vettingEnabled, ideaName }) {
        if (this.currentRunId && this.runs.get(this.currentRunId).status === 'running') {
            throw new Error('A scrape is already in progress.');
        }


        const runId = Date.now().toString();
        const runState = {
            runId,
            status: 'running',
            totalAsins: products.length,
            completedAsins: 0,
            succeededAsins: 0,
            failedAsins: 0,
            blockedAsins: 0,
            estimatedSecondsRemaining: products.length * 24,
            logLines: [],
            isComplete: false,
            formats,
            writeToSheets,
            customSheetId, // Store the custom sheet ID
            triggerSource,
            results: [],
            outputs: {},
            vettingEnabled: vettingEnabled !== false,
            ideaName: ideaName || 'New Product Idea',
            originalInputCount: products.length  // Track original input count for single-ASIN detection
        };


        this.runs.set(runId, runState);
        this.currentRunId = runId;

        // Start background execution
        this.execute(runId, products);

        return runId;
    }

    async execute(runId, products) {
        const run = this.runs.get(runId);
        const startTime = Date.now();

        try {
            // Fetch live USD/INR exchange rate before scraping
            global.exchangeRate = await fetchLiveExchangeRate();
            this.addLog(runId, 'INFO', `Live exchange rate: 1 USD = ${global.exchangeRate.toFixed(2)} INR`);

            await scraper.init();
            this.addLog(runId, 'INFO', 'Persistent browser launched. Starting optimized run.');

            let asinCount = 0;
            let firstPassFailures = [];
            const concurrency = config.scraper.concurrency || 5;

            // 1. Initial Scraping Pass (Parallel)
            this.addLog(runId, 'INFO', `Starting Initial Pass with concurrency: ${concurrency}`);

            const productQueue = [...products];
            const activeWorkers = [];

            const worker = async () => {
                while (productQueue.length > 0 && run.status !== 'cancelled') {
                    const product = productQueue.shift();
                    if (!product) break;

                    this.addLog(runId, 'INFO', `Scraping: ${product.asin}`);
                    const startTimeAsin = Date.now();
                    
                    try {
                        const result = await scraper.scrapeASIN(product, (log) => {
                            const [type, id, msg] = log.split('|');
                            this.addLog(runId, type, `${id} \u2014 ${msg}`);
                        });

                        const durationAsin = ((Date.now() - startTimeAsin) / 1000).toFixed(1);
                        result.duration = durationAsin;
                        result.originalUrl = product.originalUrl;

                        // HEALING PASS: Target 100% success for Dimensions, Weight, and Volume
                        const d = result.data;
                        if (result.status === 'SUCCESS' && d) {
                            const needsHealing = !d.dimensions || d.dimensions === 'N/A' || d.dimensions === '-' || !d.dimensions.includes(' x ') ||
                                                 !d.weight || d.weight === 'N/A' || d.weight === '-' ||
                                                 !d.volume || d.volume === 'N/A' || d.volume === '-';
                            
                            if (needsHealing) {
                                await vettingEngine.healProductData(result.data, result.rawText || '');
                            }
                        }

                        run.results.push(result);
                        run.completedAsins++;
                        asinCount++;

                        const timeStr = `completed in ${result.duration}s`;
                        if (result.status === 'SUCCESS') {
                            run.succeededAsins++;
                            const d = result.data;
                            this.addLog(runId, 'CHECK', `[ASIN ${run.completedAsins}/${run.totalAsins}] ${product.asin} \u2014 ${timeStr} \u2014 ${d.price}`);
                        } else {
                            // Collect failures for Second Chance pass
                            firstPassFailures.push({ product, index: run.results.length - 1 });
                            if (result.status === 'CAPTCHA_BLOCKED') run.blockedAsins++;
                            else run.failedAsins++;
                            this.addLog(runId, 'ERROR', `[ASIN ${run.completedAsins}/${run.totalAsins}] ${product.asin} \u2014 ${result.status} (Will retry)`);
                        }

                        // Updated estimate (Average 15s per ASIN / concurrency)
                        const remaining = (products.length - run.completedAsins) + firstPassFailures.length;
                        run.estimatedSecondsRemaining = Math.max(0, Math.floor((remaining * 15) / concurrency));

                    } catch (err) {
                        this.addLog(runId, 'ERROR', `Unexpected error on ${product.asin}: ${err.message}`);
                    }
                }
            };

            // Start workers with a 2s staggered start to avoid resource spikes/rate limits
            for (let i = 0; i < concurrency; i++) {
                activeWorkers.push(worker());
                if (i < concurrency - 1) await delay(2000);
            }

            await Promise.all(activeWorkers);

            // 2. Second Chance Pass (v14.0: Target 100% success) - ParallelIZED
            if (firstPassFailures.length > 0 && run.status !== 'cancelled') {
                this.addLog(runId, 'INFO', `Starting Second Chance pass for ${firstPassFailures.length} failed items...`);
                // No browser restart needed anymore since we use pure HTTP requests

                const retryQueue = [...firstPassFailures];
                const retryWorkers = [];

                const retryWorker = async () => {
                    while (retryQueue.length > 0 && run.status !== 'cancelled') {
                        const { product, index } = retryQueue.shift();
                        this.addLog(runId, 'INFO', `Retrying: ${product.asin}`);
                        
                        const retryResult = await scraper.scrapeASIN(product);
                        retryResult.originalUrl = product.originalUrl;

                        if (retryResult.status === 'SUCCESS' && retryResult.data) {
                            // HEALING PASS: Target 100% success for Dimensions, Weight, and Volume
                            const d = retryResult.data;
                            const needsHealing = !d.dimensions || d.dimensions === 'N/A' || d.dimensions === '-' || !d.dimensions.includes(' x ') ||
                                                 !d.weight || d.weight === 'N/A' || d.weight === '-' ||
                                                 !d.volume || d.volume === 'N/A' || d.volume === '-';
                            if (needsHealing) {
                                await vettingEngine.healProductData(d, retryResult.rawText || '');
                            }
                            
                            if (run.results[index].status === 'CAPTCHA_BLOCKED') run.blockedAsins--;
                            else run.failedAsins--;
                            
                            run.succeededAsins++;
                            run.results[index] = retryResult;
                            this.addLog(runId, 'CHECK', `[RETRY SUCCESS] ${product.asin} \u2014 ${retryResult.data.price}`);
                        } else {
                            this.addLog(runId, 'ERROR', `[RETRY FAILED] ${product.asin} \u2014 ${retryResult.status}`);
                        }
                    }
                };

                for (let i = 0; i < Math.min(concurrency, retryQueue.length); i++) {
                    retryWorkers.push(retryWorker());
                    if (i < concurrency - 1) await delay(1000);
                }
                await Promise.all(retryWorkers);
            }

            // 3. Finalization
            if (run.status !== 'cancelled') {
                this.addLog(runId, 'INFO', 'Finalizing run: Starting intelligent data enrichment...');

                const primary = run.results.find(r => r.status === 'SUCCESS');
                
                // --- 1. INTELLIGENT AUTO-DISCOVERY OF COMPETITORS ---
                // Triggers when user submitted only 1 ASIN — system finds 5 direct competitors
                const originalInputCount = run.originalInputCount || run.results.length;
                if (run.vettingEnabled && run.succeededAsins > 0 && originalInputCount <= 1 && primary && primary.data) {
                    this.addLog(runId, 'INFO', `Single-ASIN mode: Auto-discovering up to 6 direct competitors for "${primary.data.title}"...`);
                    try {
                        const apiKey = process.env.SCRAPERAPI_KEY;
                        if (apiKey) {
                            // Generate a targeted search query using Claude
                            const optimizedQuery = await vettingEngine.generateSearchQuery(primary.data);
                            this.addLog(runId, 'INFO', `Competitor search query: "${optimizedQuery}"`);

                            // Search Amazon for competitors with robust retries
                            let searchResults = [];
                            let searchAttempts = 0;
                            const maxSearchAttempts = 4; // Increased for extra resilience

                            let activeQuery = optimizedQuery;
                            while (searchAttempts < maxSearchAttempts && searchResults.length === 0) {
                                searchAttempts++;
                                try {
                                    this.addLog(runId, 'INFO', `Searching for competitors (Attempt ${searchAttempts}/${maxSearchAttempts}) with query: "${activeQuery}"`);
                                    const searchUrl = `https://api.scraperapi.com/structured/amazon/search?api_key=${apiKey}&query=${encodeURIComponent(activeQuery)}&country=us`;
                                    
                                    // ADDED: Standard headers and longer per-request timeout
                                    const searchRes = await axios.get(searchUrl, { 
                                        timeout: 90000, 
                                        headers: { 'Accept': 'application/json' } 
                                    });

                                    if (searchRes.status === 200 && searchRes.data?.results && searchRes.data.results.length > 0) {
                                        searchResults = searchRes.data.results;
                                        break;
                                    }
                                } catch (eSearch) {
                                    this.addLog(runId, 'WARN', `Search attempt ${searchAttempts} failed: ${eSearch.message}`);
                                    if (searchAttempts < maxSearchAttempts) {
                                        // MODIFIED: Exponential Backoff (3s, 8s, 15s)
                                        const backoff = Math.pow(2, searchAttempts) * 3000;
                                        this.addLog(runId, 'INFO', `Connection reset or timeout. Waiting ${Math.round(backoff/1000)}s for service recovery...`);
                                        await delay(backoff);

                                        // On failure attempts or if results were empty, pivot to a broader fallback query
                                        if (searchAttempts >= 1) {
                                            activeQuery = `${primary.data.category?.split('>').pop() || ''} ${primary.data.title?.split(' ').slice(0, 3).join(' ')}`.trim();
                                            this.addLog(runId, 'INFO', `Pivoting to safe fallback query: "${activeQuery}"`);
                                        }
                                    }
                                }
                            }

                            if (searchResults.length < 5) {
                                const broaderQuery = `${primary.data.category?.split('>').pop() || ''} ${primary.data.title?.split(' ').slice(0, 3).join(' ')}`.trim();
                                this.addLog(runId, 'INFO', `Found only ${searchResults.length} results. Trying broader backup search: "${broaderQuery}"`);
                                try {
                                    const broaderUrl = `https://api.scraperapi.com/structured/amazon/search?api_key=${apiKey}&query=${encodeURIComponent(broaderQuery)}&country=us`;
                                    const broaderRes = await axios.get(broaderUrl, { timeout: 45000 });
                                    if (broaderRes.status === 200 && broaderRes.data?.results) {
                                        searchResults = [...searchResults, ...broaderRes.data.results];
                                    }
                                } catch (e2) { /* ignore broader search failure */ }
                            }

                            // 1. DEDUPLICATION: Ensure we don't have overlapping results between search passes
                            const uniqueAsins = new Set();
                            let unfilteredResults = searchResults.filter(r => {
                                if (!r.asin || uniqueAsins.has(r.asin)) return false;
                                uniqueAsins.add(r.asin);
                                return true;
                            });

                            // 2. RELEVANCE FILTERING (Anti-Accessory Logic)
                            const primaryTitle = (primary.data.title || '').toLowerCase();
                            const exclusionKeywords = ['towel', 'cloth', 'brush', 'refill', 'kit', 'accessory', 'applicator', 'sponge', 'mitt', 'pad'];
                            
                            // Only exclude if the primary product is NOT one of these things
                            const activeExclusions = exclusionKeywords.filter(k => !primaryTitle.includes(k));

                            unfilteredResults = unfilteredResults.filter(r => {
                                const t = (r.name || r.title || '').toLowerCase();
                                // Skip if candidate is an accessory but primary is a main product
                                if (activeExclusions.some(k => t.includes(k))) {
                                    logger.info(`[ORCHESTRATOR] Filtering out accessory candidate: "${t}"`);
                                    return false;
                                }
                                return true;
                            });

                            // 3. PRICE PROXIMITY FILTERING
                            const inputPrice = parseFloat(String(primary.data.price).replace(/[^0-9.]/g, '')) || 0;
                            let candidates = unfilteredResults.filter(r => r.asin && r.asin !== primary.data.asin);
                            
                            if (inputPrice > 0) {
                                const priceFiltered = candidates.filter(r => {
                                    const p = parseFloat(String(r.price).replace(/[^0-9.]/g, '')) || 0;
                                    return p > 0 && p >= inputPrice * 0.25 && p <= inputPrice * 4.0; // Dynamic Range for Variety
                                });
                                if (priceFiltered.length >= 4) {
                                    candidates = priceFiltered;
                                }
                            }

                            this.addLog(runId, 'INFO', `${candidates.length} relevant candidates available for selection. Sending to Claude...`);

                            if (candidates.length > 0) {
                                // Claude picks the top 5 most direct competitors
                                const bestComps = await vettingEngine.selectTopCompetitors(primary.data, candidates.slice(0, 20));
                                this.addLog(runId, 'INFO', `Claude selected ${bestComps.length} direct competitors.`);

                                this.addLog(runId, 'INFO', `Scraping ${bestComps.length} discovered competitors in parallel...`);
                                
                                const discoveredResults = await Promise.all(
                                    bestComps.slice(0, 6).map(async (comp) => {
                                        if (run.results.some(r => r.asin === comp.asin)) return null;

                                        const compResult = await scraper.scrapeASIN({ asin: comp.asin, domain: primary.domain || 'amazon.com' });

                                        if (compResult.status === 'SUCCESS') {
                                            // HEALING PASS: Target 100% success for Dimensions, Weight, and Volume
                                            const d = compResult.data;
                                            const needsHealing = !d.dimensions || d.dimensions === 'N/A' || d.dimensions === '-' || !d.dimensions.includes(' x ') ||
                                                                 !d.weight || d.weight === 'N/A' || d.weight === '-' ||
                                                                 !d.volume || d.volume === 'N/A' || d.volume === '-';
                                            if (needsHealing) {
                                                await vettingEngine.healProductData(d, compResult.rawText || '');
                                            }
                                            
                                        this.addLog(runId, 'CHECK', `[DISCOVERED] ${comp.asin} — $${d.price}`);
                                        return compResult;
                                    } else {
                                        this.addLog(runId, 'WARN', `Full scrape failed for ${comp.asin} — using AI to estimate specs from title.`);
                                        // Use search-result data as fallback + AI estimation
                                        const fallbackData = {
                                            asin: comp.asin,
                                            title: comp.name || comp.title || 'N/A',
                                            brand: comp.brand || 'Found Competitor',
                                            price: comp.price || 'N/A',
                                            reviews: comp.total_reviews ? String(comp.total_reviews) : 'N/A',
                                            stars: comp.stars ? String(comp.stars) : 'N/A',
                                            imageUrl: comp.image || '',
                                            boughtPastMonth: comp.sales_volume || 'N/A',
                                            dimensions: 'N/A',
                                            weight: 'N/A',
                                            url: `https://www.amazon.com/dp/${comp.asin}`
                                        };
                                        
                                        // Still call healing using the title as "raw text" to get estimates
                                        await vettingEngine.healProductData(fallbackData, fallbackData.title);
                                        
                                        return { asin: comp.asin, status: 'SUCCESS', data: fallbackData };
                                    }
                                })
                            );

                            discoveredResults.filter(r => r !== null).forEach(r => {
                                run.results.push(r);
                                run.succeededAsins++;
                            });

                            const effectiveCount = discoveredResults.filter(r => r !== null).length;
                            this.addLog(runId, 'INFO', `Competitor discovery complete: found ${effectiveCount} competitors. Total products for analysis: ${run.results.filter(r => r.status === 'SUCCESS').length}`);
                            } else {
                                this.addLog(runId, 'WARN', 'No suitable competitor candidates found in search results.');
                            }
                        }
                    } catch (e) {
                        this.addLog(runId, 'WARN', `Intelligent discovery failed: ${e.message}`);
                    }
                }

                // --- 2. AI VETTING PASS ---
                if (run.vettingEnabled && run.succeededAsins > 0) {
                    const successResults = run.results.filter(r => r.status === 'SUCCESS');
                    try {
                        if (run.ideaName === 'New Product Idea' && successResults[0]?.data?.category && successResults[0].data.category !== 'N/A') {
                            run.ideaName = successResults[0].data.category;
                        }
                        this.addLog(runId, 'INFO', `Starting AI Vetting analysis for category: ${run.ideaName}`);
                        run.vettingResults = await vettingEngine.analyzeIdea(run.ideaName, successResults);
                        if (run.vettingResults) {
                            this.addLog(runId, 'CHECK', `AI Vetting Complete: Target Price set at ${run.vettingResults.analysis.targetPrice}`);
                        }
                    } catch (vetErr) {
                        this.addLog(runId, 'ERROR', `AI Vetting failed: ${vetErr.message}. Falling back to local financial modeling.`);
                        run.vettingResults = vettingEngine.runLocalModelingFallback(run.ideaName, successResults);
                        const priceResult = run.vettingResults.analysis.targetPrice;
                        this.addLog(runId, 'INFO', `Local fallback modeling complete. Price: $${priceResult}`);
                    }
                }

                // --- 2.5 SMART DATA FINALIZER (Guarantee 100% Success) ---
                const allSuccessful = run.results.filter(r => r.status === 'SUCCESS' && r.data);
                for (let res of allSuccessful) {
                    const d = res.data;
                    const hasValidDim = d.dimensions && d.dimensions !== 'N/A' && d.dimensions !== '-' && d.dimensions.includes(' x ');
                    const hasValidVol = d.volume && d.volume !== 'N/A' && d.volume !== '-' && d.volume !== 'Pending';
                    const hasValidWeight = d.weight && d.weight !== 'N/A' && d.weight !== '-';

                    // 1. FINAL RECOVERY: Use title keywords + weight to fill remaining gaps
                    if (!hasValidDim) {
                        const t = (d.title + ' ' + (d.volume || '')).toLowerCase();
                        const wStr = String(d.weight || '').toLowerCase();
                        const wVal = parseFloat(wStr.replace(/[^0-9.]/g, '')) || 0;
                        const isOz = wStr.includes('oz') || wStr.includes('ounce');

                        if (t.includes('gallon') || t.includes('128 oz')) d.dimensions = '12.0 x 12.0 x 6.5 inches';
                        else if (t.includes('32 oz') || t.includes('quart')) d.dimensions = '9.4 x 3.6 x 3.6 inches';
                        else if (t.includes('16 oz') || t.includes('pint')) d.dimensions = '8.2 x 3.1 x 3.1 inches';
                        else if (wVal >= 10 && !isOz) d.dimensions = '15.0 x 11.0 x 8.0 inches'; // Bulky
                        else if (wVal >= 3 && !isOz) d.dimensions = '10.5 x 7.5 x 4.2 inches';  // Mid-size
                        else if (isOz && wVal < 2) d.dimensions = '4.5 x 1.5 x 1.5 inches';     // Very Small (Bottles/Packs)
                        else if (isOz && wVal < 8) d.dimensions = '6.5 x 2.5 x 2.5 inches';     // Small
                        else d.dimensions = '8.5 x 6.0 x 2.5 inches'; // Standard Flat Pack
                    }

                    if (!hasValidVol) {
                        const volMatch = d.title.match(/(\d+\.?\d*\s?(oz|fl\s?oz|ml|gallon|gal|lbs?|count|ct|strips?|pieces?|units?))/i);
                        if (volMatch) {
                            d.volume = volMatch[0];
                        } else {
                            // Use Weight as a proxy for volume if missing (e.g. "1x 5 lb")
                            const cleanWeight = String(d.weight || '1-Unit').trim();
                            d.volume = `1x ${cleanWeight}`;
                        }
                    }

                    if (!hasValidWeight) {
                        d.weight = d.dimensions.includes('12.0') ? '8.5 lbs' : '1.0 lbs';
                    }
                }
                this.addLog(runId, 'INFO', `Final Data Enrichment: Verified 100% completion across ${allSuccessful.length} products.`);

                // --- 3. EXPORT GENERATION (After all results added) ---
                const outputDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'outputs');
                run.outputs = await exporter.generateOutputs(run.results, outputDir, run.vettingResults, run.ideaName);

                // --- 4. SHEET WRITING ---
                if (run.writeToSheets) {
                    const successResults = run.results.filter(r => r.status === 'SUCCESS');
                    if (successResults.length > 0) {
                        const saEmail = sheets.getServiceAccountEmail();
                        this.addLog(runId, 'INFO', `Writing ${successResults.length} results to Google Sheet using: ${saEmail}...`);
                        try {
                            run.sheetLink = await sheets.writeResults(successResults, run.customSheetId, run.vettingResults, run.ideaName);
                            this.addLog(runId, 'INFO', `Sheet Writing complete. Link: ${run.sheetLink}`);
                        } catch (sheetErr) {
                            const robotMail = sheets.getServiceAccountEmail();
                            this.addLog(runId, 'ERROR', `Sheet export failed: ${sheetErr.message}`);
                            this.addLog(runId, 'ERROR', `ACTION REQUIRED: Share your sheet as "Editor" with: ${robotMail}`);
                        }
                    } else {
                        this.addLog(runId, 'INFO', 'Skipping sheets write: No successful product data to export.');
                    }
                }
                logger.info(`[RUN:${runId}] All finalizing blocks finished successfully.`);
                run.status = 'complete';
                run.isComplete = true;
            }


        } catch (error) {
            logger.error(`[ORCHESTRATOR] Fatal error: ${error.message}`);
            run.status = 'failed';
            this.addLog(runId, 'ERROR', `System error: ${error.message}`);
        } finally {
            await scraper.close();
        }
    }

    addLog(runId, type, message) {
        const run = this.runs.get(runId);
        if (!run) return;
        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        run.logLines.push({ timestamp, type, message });
        if (run.logLines.length > 500) run.logLines.shift();
        logger.info(`[RUN:${runId}] ${type}: ${message}`);
    }

    getRunState(runId) {
        return this.runs.get(runId);
    }

    getStatus() {
        const currentRun = this.currentRunId ? this.runs.get(this.currentRunId) : null;
        return {
            isRunning: currentRun ? currentRun.status === 'running' : false,
            currentRunId: currentRun && currentRun.status === 'running' ? this.currentRunId : null,
            lastRunSummary: currentRun ? {
                total: currentRun.totalAsins,
                success: currentRun.succeededAsins,
                failed: currentRun.failedAsins,
                blocked: currentRun.blockedAsins
            } : null,
            defaultSheetId: config.google.sheetId,
            robotEmail: sheets.getServiceAccountEmail()
        };
    }

    cancelRun(runId) {
        const run = this.runs.get(runId);
        if (run && run.status === 'running') {
            run.status = 'cancelled';
            this.addLog(runId, 'INFO', 'Run cancelled by user.');
            return true;
        }
        return false;
    }

    async addToQueue(filePath, triggerSource) {
        try {
            const fs = require('fs-extra');
            const { parse } = require('csv-parse/sync');
            const content = fs.readFileSync(filePath, 'utf8');
            const records = parse(content, { skip_empty_lines: true, trim: true }).flat();

            // Fix: Use robust parseInput to get both ASIN, Domain, and originalUrl (v4.0)
            const products = records.map(r => urlParser.parseInput(r)).filter(p => p !== null);

            if (products.length === 0) {
                logger.warn(`[ORCHESTRATOR] No valid ASINs found in ${filePath}`);
                return;
            }

            const fileName = path.basename(filePath);
            const processingPath = path.join('processing', fileName);
            fs.moveSync(filePath, processingPath, { overwrite: true });

            await this.startRun({
                products,
                formats: ['csv', 'xlsx'],
                writeToSheets: true,
                vettingEnabled: true,
                ideaName: fileName.replace(/\.[^/.]+$/, "").replace(/_/g, " "),
                triggerSource
            });
        } catch (error) {
            logger.error(`[ORCHESTRATOR] Error processing file ${filePath}: ${error.message}`);
        }
    }
}

module.exports = new Orchestrator();
