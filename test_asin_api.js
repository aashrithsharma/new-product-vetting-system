require('dotenv').config();
const axios = require('axios');

async function test() {
    const asin = 'B000VX7HKW';
    const apiKey = process.env.SCRAPERAPI_KEY;
    const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${apiKey}&asin=${asin}&country=us`;

    console.log("Fetching ScraperAPI for:", asin);
    try {
        const res = await axios.get(url, { timeout: 60000 });
        console.log("Status:", res.status);
        console.log("Price Data:", JSON.stringify({
            pricing: res.data.pricing,
            price: res.data.price,
            buybox_price: res.data.buybox_price
        }, null, 2));
    } catch (e) {
        console.error("Error:", e.message);
    }
}

test();
