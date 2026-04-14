const axios = require('axios');
require('dotenv').config();

async function testSearch() {
    const apiKey = process.env.SCRAPERAPI_KEY;
    const query = "pool water test kit";
    const url = `https://api.scraperapi.com/structured/amazon/search?api_key=${apiKey}&query=${encodeURIComponent(query)}&country=us`;
    
    console.log(`Testing URL: ${url}`);
    
    try {
        const res = await axios.get(url, { 
            timeout: 60000,
            // Headers omitted as in orchestrator.js
        });
        console.log("Success with NO headers!");
        console.log("Result count:", res.data?.results?.length);
    } catch (e) {
        console.error("Failed with NO headers:", e.message, e.code);
    }

    try {
        const res = await axios.get(url, { 
            timeout: 60000,
            headers: { 'Accept': 'application/json' }
        });
        console.log("Success WITH headers!");
        console.log("Result count:", res.data?.results?.length);
    } catch (e) {
        console.error("Failed WITH headers:", e.message, e.code);
    }
}

testSearch();
