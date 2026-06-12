require('dotenv').config();
const scraper = require('../scraper');
const logger = require('../logger');

async function testPriceFix() {
    const asin = 'B0F32QTSXS';
    console.log(`\nStarting Internal Test for ASIN: ${asin}`);
    console.log('-------------------------------------------');

    try {
        const result = await scraper.scrapeASIN(asin);
        
        if (result.status === 'SUCCESS') {
            const data = result.data;
            console.log(`\n[SUCCESS] Data extracted for ${asin}:`);
            console.log(`Title:  ${data.title.substring(0, 50)}...`);
            console.log(`Price:  ${data.price} <--- CHECK THIS VALUE`);
            console.log(`Brand:  ${data.brand}`);
            console.log(`Badge:  ${data.boughtPastMonth}`);
            
            if (data.price === '$0.40') {
                console.log('\n[ERROR] Price is still showing as $0.40. Fix failed.');
            } else if (data.price === 'N/A') {
                console.log('\n[WARNING] Price is N/A. The filter might be too aggressive or the tag moved.');
            } else {
                console.log(`\n[VERIFIED] Price looks correct: ${data.price}`);
            }
        } else {
            console.log(`\n[FAILED] Scrape failed: ${result.reason}`);
        }
    } catch (error) {
        console.error(`\n[CRITICAL ERROR] during test: ${error.message}`);
    }
}

testPriceFix();
