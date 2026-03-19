require('dotenv').config();
const scraper = require('./scraper');

async function debugHTML() {
    await scraper.init();
    const context = await scraper.createContext();
    const page = await context.newPage();
    const url = 'https://www.amazon.com/Washing-Machine-Cleaner-Tablets-Owners/dp/B0DX24WXHJ/?th=1';
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    
    const priceText = await page.evaluate(() => {
        const offscreens = Array.from(document.querySelectorAll('.a-offscreen, .aok-offscreen, span[aria-hidden="true"]'));
        return offscreens.map(e => e.textContent.trim() + " (class=" + e.className + " id=" + e.id + ")");
    });
    
    console.log(JSON.stringify(priceText, null, 2));
    await context.close();
    await scraper.close();
    process.exit(0);
}

debugHTML();
