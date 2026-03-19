const scraper = require('./scraper');
const logger = require('./logger');

async function runTest() {
    try {
        await scraper.init();
        const product = {
            asin: 'B0GQVPPGGK',
            domain: 'amazon.com',
            originalUrl: 'https://www.amazon.com/Apple-iPhone-Silicone-MagSafe-Control/dp/B0GQVPPGGK?th=1'
        };
        console.log("--- STARTING TEST FOR B0GQVPPGGK ---");
        const result = await scraper.scrapeASIN(product, (log) => {
            console.log(log);
        });
        console.log("\n--- FINAL RESULT ---");
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await scraper.close();
    }
}

runTest();
