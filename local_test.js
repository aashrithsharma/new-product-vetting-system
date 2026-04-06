const orchestrator = require('./orchestrator');
const vettingEngine = require('./vettingEngine');
const scraper = require('./scraper');

async function testLocally() {
    const asins = ['B008UMFVZE', 'B008UMEF2O', 'B0017T0IZ0', 'B07G8KWGSK', 'B007ZU4I2E', 'B08DBRPT5K'];
    console.log('--- STARTING LOCAL BATCH ANALYSIS FOR USER VERIFICATION ---');

    const results = [];
    for (const asin of asins) {
        console.log(`Scraping ${asin}...`);
        try {
            const res = await scraper.scrapeASIN({ asin });
            if (res.status === 'SUCCESS') results.push(res);
        } catch(e) {}
    }

    if (results.length === 0) {
        console.error('FAILED: No successful scrapes.');
        return;
    }

    console.log(`\nAnalyzing ${results.length} successful items...`);
    const idea = 'Pool Clarifiers - Vetting Batch';
    const v = await vettingEngine.analyzeIdea(idea, results);

    if (v && v.financials) {
        const scenarios = v.financials.scenarios;
        const metrics = v.financials.annualMetrics;

        console.log('\n================================================================');
        console.log('   TABLE 1 — UNIT ECONOMICS & PRICE LADDER PREVIEW   ');
        console.log('================================================================');
        console.log('Units/Day | Price | Daily Rev | Annual Rev | Status');
        scenarios.slice(10, 20).forEach(s => {
            const likeliness = s.isMostLikely ? ' [RECOMMENDED]' : '';
            console.log(`${s.unitsPerDay.toString().padEnd(9)} | $${s.sellingPrice.toFixed(2).padEnd(6)} | $${s.dailyRevenue.toFixed(0).padEnd(8)} | $${s.expectedAnnualRevenue.toLocaleString().padEnd(10)} | ${s.baseballCategory}${likeliness}`);
        });

        console.log('\n================================================================');
        console.log('   TABLE 2 — PRODUCT SUMMARY METRICS (ANNUAL BUSINESS CASE)   ');
        console.log('================================================================');
        console.log(`Product Name:    ${idea}`);
        console.log(`Annual Revenue:  $${metrics.annualRevenue.toLocaleString()}`);
        console.log(`Avg Inv Units:   ${metrics.avgInvUnits.toFixed(0)}`);
        console.log(`Avg Inv Value:   $${metrics.avgInvValue.toLocaleString()}`);
        console.log(`Return Rate:     ${(metrics.retRate*100).toFixed(1)}%`);
        console.log(`Gross Margin %:  ${(metrics.grossMarginPct*100).toFixed(1)}%`);
        console.log(`ROIC:            ${metrics.roic.toFixed(1)}%`);
        console.log(`Ad Spend Total:  $${metrics.adSpendTotal.toLocaleString()}`);
        console.log(`Annual Contrib:  $${metrics.annualContributionMargin.toLocaleString()}`);
        console.log(`Net Margin:      ${(metrics.netMarginAfterAdsPct*100).toFixed(1)}%`);
        console.log(`Baseball Tier:   ${v.analysis.baseballCategory}`);
        console.log('================================================================');
    }
}

testLocally();
