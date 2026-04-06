const sheets = require('./sheets');
const config = require('./config');

async function test() {
    const results = [
        {
            asin: 'B0BZV6W8X9',
            status: 'SUCCESS',
            data: {
                title: 'Test Product',
                brand: 'Test Brand',
                price: '$99.99',
                stars: '4.5',
                reviews: '100',
                imageUrl: 'https://example.com/img.jpg',
                originalUrl: 'https://www.amazon.com/dp/B0BZV6W8X9'
            }
        }
    ];

    // Test with the user's provided sheet ID
    const customId = '1NEpxeAVVtxLpDqD9kReqMM0wZBn-6Q2isgRziUAWkDg';
    console.log('Testing with user provided sheet ID:', customId);
    try {
        const link = await sheets.writeResults(results, customId);
        if (link) {
            console.log('✅ Success with user sheet! Link:', link);
        } else {
            console.log('❌ Failed with user sheet: Link is null (Check logs/permissions)');
        }
    } catch (err) {
        console.error('❌ Caught Exception with user sheet:', err.message);
    }
}

test();
