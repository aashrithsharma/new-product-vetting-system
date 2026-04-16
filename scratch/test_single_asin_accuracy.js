require('dotenv').config();
const ScraperEngine = require('../scraper');
const VettingEngine = require('../vettingEngine');
const logger = require('../logger');

async function testSingleAsin(asin) {
    const scraper = require('../scraper');
    const vetting = require('../vettingEngine');

    console.log(`\n=== TESTING ASIN: ${asin} ===`);
    
    // 1. Scrape
    const result = await scraper.scrapeASIN(asin);
    
    if (result.status !== 'SUCCESS') {
        console.error(`Scrape failed: ${result.reason}`);
        return;
    }

    console.log("\n[RAW SCRAPER DATA]");
    console.log(`Title: ${result.data.title}`);
    console.log(`Dimensions: ${result.data.dimensions}`);
    console.log(`Weight: ${result.data.weight}`);
    console.log(`Volume: ${result.data.volume}`);
    console.log(`HTML Length: ${result.rawText ? result.rawText.length : 0} chars`);

    // 2. AI Heal
    console.log("\n[HEALING PASS]");
    const healed = await vetting.healProductData(result.data, result.rawText);

    console.log("\n[HEALED DATA]");
    console.log(`Dimensions: ${healed.dimensions}`);
    console.log(`Weight: ${healed.weight}`);
    console.log(`Volume: ${healed.volume}`);
    
    if (healed.dimensions === '8.5 x 6.0 x 2.5 inches') {
        console.log("\n!!! WARNING: Still seeing generic fallback value !!!");
    } else {
        console.log("\n✅ SUCCESS: Custom dimensions detected.");
    }
}

const targetAsin = process.argv[2] || 'B0DX24WXHJ';
testSingleAsin(targetAsin).catch(console.error);
