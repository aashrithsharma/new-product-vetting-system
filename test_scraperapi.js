require('dotenv').config();

async function test() {
    const asin = 'B0DX24WXHJ';
    const apiKey = process.env.SCRAPERAPI_KEY;
    if (!apiKey) {
        console.log("No key");
        return;
    }

    const url =
        'https://api.scraperapi.com' +
        '/structured/amazon/product' +
        `?api_key=${apiKey}` +
        `&asin=${asin}` +
        `&country=us`;

    console.log("Fetching:", url.replace(apiKey, 'HIDDEN'));
    const res = await fetch(url);
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Body:", text);
}

test();
