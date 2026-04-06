const scraper = require('./scraper');
const engine = require('./antigravity-engine');
const sheets = require('./antigravity-sheets');
const logger = require('./logger');

async function runTest() {
    const ideaName = "9 in 1 Water Test Kit for Pool";
    const asins = [
        'B000VX7HKW'
    ];

    try {
        logger.info("[TEST] Starting Antigravity Project 2 Test...");
        
        // 1. Scrape data
        const results = [];
        for (const asin of asins) {
            logger.info(`[TEST] Scraping ${asin}...`);
            const res = await scraper.scrapeASIN({ asin, domain: 'amazon.com' });
            if (res.status === 'SUCCESS') results.push(res);
        }

        if (results.length === 0) {
            logger.error("[TEST] No data scraped. Check API keys/connection.");
            return;
        }

        // 2. Run AI Analysis
        logger.info("[TEST] Running Claude Analysis...");
        const vetting = await engine.analyzeIdea(ideaName, results);
        console.log("Claude Analysis Result:", JSON.stringify(vetting.analysis, null, 2));

        // 3. Write to Google Sheets
        logger.info("[TEST] Writing to Google Sheets...");
        const sheetLink = await sheets.writeCalculator(results, null, vetting, ideaName);
        
        logger.info(`[TEST] COMPLETED! View your sheet here: ${sheetLink}`);
        
        // 4. Output Verdict
        const a = vetting.analysis.sku1;
        console.log(`
---
PRODUCT: ${a.name}
Recommended selling price: $${a.regularPrice}
Target COGS: $${a.targetCogs}
Baseball Category: ${a.baseballCategory}
Most Likely Units/Day: ${a.mostLikelyUnitsPerDay}
OVERALL VERDICT: ${vetting.analysis.executiveSummary.includes('CONTINUE') ? 'CONTINUE' : 'REVIEW SUMMARY'}
Reason: ${vetting.analysis.executiveSummary.substring(0, 100)}...
---
        `);

    } catch (err) {
        logger.error(`[TEST] Error: ${err.message}`);
        console.error(err);
    }
}

runTest();
