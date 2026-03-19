const scraper = require('./scraper');
const logger = require('./logger');

async function runTest() {
    try {
        await scraper.init();
        const result = await scraper.scrapeASIN('B003IS3HV0', () => {});
        console.log("--- FINAL RESULT ---");
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error:", e);
    } finally {
        await scraper.close();
    }
}

runTest();
