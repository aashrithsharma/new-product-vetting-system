require('dotenv').config();
const axios = require('axios');
const vettingEngine = require('./vettingEngine');

const TEST_ASIN = 'B008UMFVZE'; // SeaKlear Pool Clarifier

async function run() {
    console.log('==============================================');
    console.log(' GEMINI API — QUICK LOCAL TEST');
    console.log('==============================================');
    console.log(`GEMINI_API_KEY present : ${!!process.env.GEMINI_API_KEY}`);
    console.log(`SCRAPERAPI_KEY present : ${!!process.env.SCRAPERAPI_KEY}`);

    // ── Step 1: Fetch product data via ScraperAPI structured endpoint ──
    console.log(`\n[1/2] Fetching ASIN ${TEST_ASIN} via ScraperAPI Structured JSON...`);
    let raw;
    try {
        const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${process.env.SCRAPERAPI_KEY}&asin=${TEST_ASIN}&country=us`;
        const res = await axios.get(url, { timeout: 30000 });
        raw = res.data;
    } catch (e) {
        console.error('❌ ScraperAPI error:', e.message);
        return;
    }

    // Normalise into the shape vettingEngine expects
    const productData = {
        status: 'SUCCESS',
        asin: TEST_ASIN,
        data: {
            asin:           TEST_ASIN,
            title:          raw.name || raw.title || 'N/A',
            brand:          raw.brand || 'N/A',
            price:          raw.pricing || raw.price || 'N/A',
            reviews:        String(raw.total_reviews || 'N/A'),
            stars:          String(raw.stars || raw.average_rating || 'N/A'),
            bsr:            raw.bestsellers_rank?.[0]?.rank || 'N/A',
            boughtPastMonth:raw.sales_volume || 'N/A',
            dimensions:     raw.product_information?.package_dimensions || 'N/A',
            weight:         raw.product_information?.item_weight || 'N/A',
            category:       raw.category_name || 'N/A',
            bulletPoints:   (raw.feature_bullets || []).join(' '),
            description:    raw.product_description || ''
        }
    };

    const d = productData.data;
    console.log('\n✅ Scrape SUCCESS');
    console.log(`   Title  : ${d.title}`);
    console.log(`   Price  : ${d.price}`);
    console.log(`   BSR    : ${d.bsr}`);
    console.log(`   Stars  : ${d.stars}`);
    console.log(`   Reviews: ${d.reviews}`);
    console.log(`   Sales  : ${d.boughtPastMonth}`);
    console.log(`   Weight : ${d.weight}`);
    console.log(`   Dims   : ${d.dimensions}`);

    // ── Step 2: Gemini vetting analysis ──
    console.log('\n[2/2] Running Gemini vetting analysis...');
    console.log('       (this calls Gemini API — may take 10-20s)');

    let result;
    try {
        result = await vettingEngine.analyzeIdea('Pool Clarifier', [productData]);
    } catch (e) {
        console.error('❌ Gemini vetting error:', e.message);
        return;
    }

    if (!result) {
        console.error('❌ Vetting returned no result');
        return;
    }

    const a = result.analysis;
    console.log('\n✅ Gemini Analysis SUCCESS');
    console.log('----------------------------------------------');
    console.log(`   Target Price     : $${a.targetPrice}`);
    console.log(`   Most Likely/day  : ${a.mostLikelyUnitsPerDay} units`);
    console.log(`   Best Case/day    : ${a.bestCaseUnitsPerDay} units`);
    console.log(`   Seasonality      : ${a.seasonality} days`);
    console.log(`   Baseball Cat     : ${a.baseballCategory}`);
    console.log(`   Return Rate      : ${(a.returnRate * 100).toFixed(1)}%`);
    console.log(`   Format Research  : ${a.formatResearch}`);
    console.log(`   Brief            :`);
    console.log(`     ${a.intelligenceBrief}`);

    if (result.financials) {
        const f = result.financials.annualMetrics;
        console.log('\n--- Financials ---');
        console.log(`   Annual Revenue   : $${(f.annualRevenue || 0).toLocaleString()}`);
        console.log(`   Gross Margin     : ${((f.grossMarginPct || 0) * 100).toFixed(1)}%`);
        console.log(`   ROIC             : ${(f.roic || 0).toFixed(1)}%`);
        console.log(`   Annual Contrib   : $${(f.annualContributionMargin || 0).toLocaleString()}`);
    }

    console.log('\n==============================================');
    console.log(' ALL SYSTEMS GREEN ✅  Gemini API is working!');
    console.log('==============================================');
}

run().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
