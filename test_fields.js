require('dotenv').config();
const scraper = require('./scraper');

const ASIN = process.argv[2] || 'B0DX24WXHJ'; // Default to the example ASIN

(async () => {
    console.log(`\n🔍 Testing field extraction for ASIN: ${ASIN}\n`);
    const result = await scraper.scrapeASIN({ asin: ASIN, domain: 'www.amazon.com' });

    if (result.status !== 'SUCCESS') {
        console.log('❌ Scrape failed:', result.status, result.reason);
        process.exit(1);
    }

    const d = result.data;
    const check = (label, val) => {
        const ok = val && val !== 'N/A' && val !== '';
        console.log(`${ok ? '✅' : '❌'} ${label.padEnd(20)} ${val}`);
    };

    check('Rating (stars)',  d.stars);
    check('Reviews',         d.reviews);
    check('Item Weight',     d.weight);
    check('Dimensions',      d.dimensions);
    check('Price',           d.price);
    check('BSR',             d.bsr);
    check('Brand',           d.brand);
    check('Title',           d.title?.substring(0, 60));

    process.exit(0);
})();
