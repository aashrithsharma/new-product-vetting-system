const scraper = require('../scraper');
const logger = require('../logger');

async function deepVerify() {
    console.log('==========================================');
    console.log('DEEP ASIN VERIFICATION (LIVE)');
    console.log('==========================================\n');

    const asin = 'B0F32QTSXS';
    
    try {
        await scraper.init();
        console.log(`[DEBUG] Scraping ASIN: ${asin}...`);
        
        const result = await scraper.scrapeASIN({ asin, domain: 'amazon.com' });
        
        if (result.status === 'SUCCESS') {
            console.log('\n--- LIVE DATA EXTRACTED ---');
            console.log(`Title: ${result.data.title}`);
            console.log(`Price: ${result.data.price}`);
            console.log(`Sales Badge Found: "${result.data.boughtPastMonth}"`);
            console.log(`Est. Units/Day Calculation: ${result.data.estUnitsPerDay || 'N/A'}`);
            
            // Check rawText for hidden badges
            const raw = result.rawText || '';
            const allBadges = raw.match(/\d+K?\+? bought in past month/gi);
            console.log('\n--- ALL BADGES DETECTED IN HTML ---');
            if (allBadges) {
                console.log(Array.from(new Set(allBadges)));
            } else {
                console.log('No badges found in raw text samples.');
            }

            console.log('\n--- SYSTEM TAGS ---');
            console.log(`Tier Assigned: ${result.data.tier || 'Pending'}`);
            console.log(`Variations Detected: ${raw.includes('variationDisplayNames') ? 'YES' : 'NO'}`);

        } else {
            console.log(`[FAILED] Scraper returned status: ${result.status}`);
        }

    } catch (err) {
        console.error('Deep Verify Failed:', err.message);
    } finally {
        await scraper.close();
    }
}

deepVerify();
