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

                        if (retryResult.status === 'SUCCESS') {
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
                            const maxSearchAttempts = 3;

                            let activeQuery = optimizedQuery;
                            while (searchAttempts < maxSearchAttempts && searchResults.length === 0) {
                                searchAttempts++;
                                try {
                                    this.addLog(runId, 'INFO', `Searching for competitors (Attempt ${searchAttempts}/${maxSearchAttempts}) with query: "${activeQuery}"`);
                                    const searchUrl = `https://api.scraperapi.com/structured/amazon/search?api_key=${apiKey}&query=${encodeURIComponent(activeQuery)}&country=us`;
                                    const searchRes = await axios.get(searchUrl, { timeout: 60000 });
                                    if (searchRes.status === 200 && searchRes.data?.results && searchRes.data.results.length > 0) {
                                        searchResults = searchRes.data.results;
                                        break;
                                    }
                                } catch (eSearch) {
                                    this.addLog(runId, 'WARN', `Search attempt ${searchAttempts} failed: ${eSearch.message}`);
                                    if (searchAttempts < maxSearchAttempts) {
                                        await delay(3000);
                                        // On last attempt (or if first failed with empty), try a broader fallback query
                                        if (searchAttempts === 1 || searchAttempts === maxSearchAttempts - 1) {
                                            activeQuery = `${primary.data.category?.split('>').pop() || ''} ${primary.data.title?.split(' ').slice(0, 3).join(' ')}`.trim();
                                            this.addLog(runId, 'INFO', `Switching to safe fallback query for next attempt: "${activeQuery}"`);
                                        }
                                    }
                                }
                            }

                            // If first search returns too few, try a broader search IF we haven't already tried a retry
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

                            // Pre-filter by price proximity (within ±70% of input price) - loosened to avoid total failure
                            const inputPrice = parseFloat(String(primary.data.price).replace(/[^0-9.]/g, '')) || 0;
                            let candidates = searchResults.filter(r => r.asin && r.asin !== primary.data.asin);
                            
                            if (inputPrice > 0) {
                                const priceFiltered = candidates.filter(r => {
                                    const p = parseFloat(String(r.price).replace(/[^0-9.]/g, '')) || 0;
                                    return p > 0 && p >= inputPrice * 0.3 && p <= inputPrice * 3.0; // Loosened from 0.4-1.6 to 0.3-3.0
                                });
                                // Only use filtered results if we still have at least 3, otherwise stick to original candidates
                                if (priceFiltered.length >= 3) {
                                    candidates = priceFiltered;
                                }
                            }

                            this.addLog(runId, 'INFO', `${candidates.length} candidates available for selection. Sending to Claude...`);

                            if (candidates.length > 0) {
                                // Claude picks the top 5 most direct competitors
                                const bestComps = await vettingEngine.selectTopCompetitors(primary.data, candidates.slice(0, 20));
                                this.addLog(runId, 'INFO', `Claude selected ${bestComps.length} direct competitors.`);

                                let discovered = 0;
                                for (const comp of bestComps) {
                                    if (discovered >= 6) break; // Find up to 6 to be safe
                                    if (run.results.some(r => r.asin === comp.asin)) continue;

                                    this.addLog(runId, 'INFO', `Scraping competitor [${discovered + 1}/6]: ${comp.asin}`);
                                    const compResult = await scraper.scrapeASIN({ asin: comp.asin, domain: primary.domain || 'amazon.com' });

                                    if (compResult.status === 'SUCCESS') {
                                        run.results.push(compResult);
                                        run.succeededAsins++;
                                        this.addLog(runId, 'CHECK', `[DISCOVERED] ${comp.asin} — $${compResult.data.price} — ${compResult.data.brand || 'N/A'}`);
                                        discovered++;
                                    } else {
                                        // Use search-result data as fallback so it still appears in the comparison
                                        run.results.push({
                                            asin: comp.asin,
                                            status: 'SUCCESS',
                                            data: {
                                                asin: comp.asin,
                                                title: comp.name || comp.title || 'N/A',
                                                brand: comp.brand || 'Found Competitor',
                                                price: comp.price || 'N/A',
                                                reviews: comp.total_reviews ? String(comp.total_reviews) : 'N/A',
                                                stars: comp.stars ? String(comp.stars) : 'N/A',
                                                imageUrl: comp.image || '',
                                                boughtPastMonth: comp.sales_volume || 'N/A',
                                                url: `https://www.amazon.com/dp/${comp.asin}`
                                            }
                                        });
                                        run.succeededAsins++;
                                        this.addLog(runId, 'WARN', `Full scrape failed for ${comp.asin} — using search data as fallback.`);
                                        discovered++;
                                    }
                                }
                                this.addLog(runId, 'INFO', `Competitor discovery complete: found ${discovered} competitors. Total products for analysis: ${run.results.filter(r => r.status === 'SUCCESS').length}`);
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
                        const price = successResults[0]?.data?.price || 29.99;
                        run.vettingResults = vettingEngine.runLocalModelingFallback(run.ideaName, price);
                        this.addLog(runId, 'INFO', `Local fallback modeling complete. Price: $${price}`);
                    }
                }

                // --- 3. EXPORT GENERATION (After all results added) ---
                const outputDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'outputs');
                run.outputs = await exporter.generateOutputs(run.results, outputDir, run.vettingResults, run.ideaName);

                // --- 4. SHEET WRITING ---
                if (run.writeToSheets) {
                    const successResults = run.results.filter(r => r.status === 'SUCCESS');
                    if (successResults.length > 0) {
                        this.addLog(runId, 'INFO', `Writing ${successResults.length} results to a single Google Sheet...`);
                        run.sheetLink = await sheets.writeResults(successResults, run.customSheetId, run.vettingResults, run.ideaName);
                        this.addLog(runId, 'INFO', `Sheet Writing complete. Link: ${run.sheetLink}`);
                    }
                }

                run.status = 'complete';
                run.isComplete = true;
                logger.info(`[RUN:${runId}] All finalizing blocks finished successfully.`);
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
            } : null
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
