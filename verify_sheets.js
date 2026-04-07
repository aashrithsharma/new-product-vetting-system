const sheets = require('./sheets');
const logger = require('./logger');
require('dotenv').config();

async function verify() {
    console.log('--- Sheets Verification Script ---');
    const sheetId = process.env.GOOGLE_SHEET_ID;
    console.log(`Target Sheet ID: ${sheetId}`);

    const testResults = [
        {
            status: 'SUCCESS',
            data: {
                asin: 'B0TEST123',
                title: 'ANTIGRAVITY TEST PRODUCT',
                brand: 'Antigravity AI',
                price: '$99.99',
                stars: '5.0',
                reviews: '1234',
                imageUrl: 'https://m.media-amazon.com/images/I/71u-g0x4kBL._AC_SL1500_.jpg'
            }
        }
    ];

    try {
        console.log('Attempting to write test row to Google Sheets...');
        const link = await sheets.writeResults(testResults, sheetId, null, "Antigravity Dev Test");
        if (link) {
            console.log(`✅ SUCCESS! Sheet updated. Public Link: ${link}`);
        } else {
            console.log('❌ FAILED: writeResults returned null.');
        }
    } catch (e) {
        console.error('❌ FATAL ERROR:');
        console.error(e.message);
        console.error(e.stack);
    }
}

verify();
