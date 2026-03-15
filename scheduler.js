const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const logger = require('./logger');
const orchestrator = require('./orchestrator');
const config = require('./config');

/**
 * 7 AM daily automated schedule
 */
function startScheduler() {
    const schedule = config.schedule.cron;
    const timezone = config.schedule.timezone;

    logger.info(`[SCHEDULER] Registering daily job: ${schedule} [${timezone}]`);

    cron.schedule(schedule, async () => {
        logger.info('[SCHEDULER] Triggering 7 AM daily scrape...');

        const watchlistPath = path.join('data', 'watchlist.csv');
        if (!fs.existsSync(watchlistPath)) {
            logger.warn('[SCHEDULER] watchlist.csv not found, skipping.');
            return;
        }

        try {
            const content = fs.readFileSync(watchlistPath, 'utf8');
            const records = parse(content, { skip_empty_lines: true, trim: true }).flat();
            const urlParser = require('./urlParser');
            const products = [...new Map(records.map(r => urlParser.parseInput(r)).filter(p => p !== null).map(p => [p.asin, p])).values()];

            if (products.length === 0) {
                logger.warn('[SCHEDULER] No valid ASINs found in watchlist.csv.');
                return;
            }

            logger.info(`[SCHEDULER] Starting scheduled run with ${products.length} products`);
            await orchestrator.startRun({
                products,
                formats: ['csv', 'xlsx'],
                writeToSheets: true,
                triggerSource: 'Daily Scheduler'
            });

        } catch (error) {
            logger.error(`[SCHEDULER] Error: ${error.message}`);
        }
    }, { timezone });
}

module.exports = startScheduler;
