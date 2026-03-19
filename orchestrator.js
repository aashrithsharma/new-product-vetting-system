const logger = require('./logger');
const scraper = require('./scraper');
const sheets = require('./sheets');
// const notifier = require('./notifier'); // Slack removed
const exporter = require('./exporter');
const config = require('./config');
const { delay } = require('./utils');
const urlParser = require('./urlParser');
const axios = require('axios');

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

    async startRun({ products, formats, writeToSheets, triggerSource }) {
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
            triggerSource,
            results: [],
            outputs: {}
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

            // Start workers with a 2s staggered start to avoid resource spikes
            for (let i = 0; i < concurrency; i++) {
                activeWorkers.push(worker());
                if (i < concurrency - 1) await delay(2000);
            }

            await Promise.all(activeWorkers);

            // 2. Second Chance Pass (v14.0: Target 100% success) - ParallelIZED
            if (firstPassFailures.length > 0 && run.status !== 'cancelled') {
                this.addLog(runId, 'INFO', `Starting Second Chance pass for ${firstPassFailures.length} failed items...`);
                await scraper.close();
                await delay(3000);
                await scraper.init();

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
                run.status = 'complete';
                this.addLog(runId, 'INFO', 'Run complete. Finalizing...');

                if (run.writeToSheets) {
                    await sheets.init();
                    run.sheetLink = await sheets.writeResults(run.results);
                }

                run.outputs = await exporter.generateOutputs(run.results, runId);
                run.isComplete = true;

                const duration = (Date.now() - startTime) / 60000;
                /*
                await notifier.sendNotification({
                    status: 'complete',
                    trigger: run.triggerSource,
                    total: run.totalAsins,
                    success: run.succeededAsins,
                    failed: run.failedAsins,
                    blocked: run.blockedAsins,
                    duration,
                    sheetLink: run.sheetLink,
                    failedAsins: run.results.filter(r => r.status !== 'SUCCESS').map(r => ({ asin: r.asin, reason: r.reason }))
                });
                */
                logger.info('[ORCHESTRATOR] Run summary notification skipped (Slack disabled)');
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
                triggerSource
            });
        } catch (error) {
            logger.error(`[ORCHESTRATOR] Error processing file ${filePath}: ${error.message}`);
        }
    }
}

module.exports = new Orchestrator();
