const engine = require('./scraper');
const logger = require('./logger');

async function test() {
    // Set exchange rate to avoid fallback warnings if needed
    global.exchangeRate = 83;

    // ASIN from user image
    const asin = 'B07FDJMC9Q';
    const domain = 'www.amazon.com';
    
    logger.info(`Starting test for ASIN: ${asin}`);
    
    try {
        const result = await engine.scrapeASIN({ asin, domain });
        console.log('\n--- TEST RESULT ---');
        console.log(JSON.stringify(result, null, 2));
        console.log('--- END RESULT ---\n');
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        await engine.close();
        process.exit(0);
    }
}

test();
