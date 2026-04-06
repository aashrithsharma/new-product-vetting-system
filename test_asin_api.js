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
        console.log("Keys available:", Object.keys(res.data));
        console.log("Name:", res.data.name);
        console.log("Title:", res.data.title);
        console.log("Product Name:", res.data.product_name);
    } catch (e) {
        console.error("Error:", e.message);
    }
}

test();
