const scraper = require('./scraper');
const logger = require('./logger');

async function testV32() {
    const asins = [
        'B000VX7HKW', // Miracle Sealants
        'B000UOJGME', // Failing in screenshot
        'B0DX24WXHJ', // Failing in screenshot
        'B003IS3HV0', // Leather Honey (Failing Brand/Price)
        'B00GRT125A'  // Leather CPR (INR issue)
    ];

    console.log('--- v3.2 VERIFICATION START ---');
    console.log('Testing ASINs:', asins.join(', '));

    try {
        await scraper.init();

        for (const asin of asins) {
            console.log(`\nTesting ${asin}...`);
            const result = await scraper.scrapeASIN(asin, (log) => console.log(`  > ${log}`));

            if (result.status === 'SUCCESS') {
                const d = result.data;
                console.log(`  [SUCCESS] Brand: ${d.brand}, Price: ${d.price}, BSR: ${d.bsr}`);
                if (!d.price.includes('$')) {
                    console.error('  [!!] ERROR: Price is NOT in USD!');
                }
            } else {
                console.error(`  [FAILED] Status: ${result.status}, Reason: ${result.reason}`);
            }
        }
    } catch (err) {
        console.error('Fatal error during verification:', err);
    } finally {
        await scraper.close();
        console.log('\n--- v3.2 VERIFICATION END ---');
    }
}

testV32();
