
const scraper = require('../scraper');
require('dotenv').config();

async function test() {
    const asin = 'B00FLYWNYQ';
    const domain = 'amazon.com';
    console.log(`Testing scrape for ASIN: ${asin}`);
    try {
        const result = await scraper.scrapeASIN({ asin, domain });
        console.log('Result Status:', result.status);
        if (result.status === 'SUCCESS') {
            console.log('Title:', result.data.title);
            console.log('Price:', result.data.price);
        } else {
            console.log('Reason:', result.reason);
        }
    } catch (err) {
        console.error('Error:', err);
    }
}

test();
