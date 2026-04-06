require('dotenv').config();
const scraper = require('./scraper');
const fs = require('fs');

const origLog = console.log;
const origInfo = console.info;
const origWarn = console.warn;
const origError = console.error;

const logFile = fs.createWriteStream('run.log');
console.log = (...args) => {
    logFile.write(args.join(' ') + '\n');
};
console.info = console.log;
console.warn = console.log;
console.error = console.log;

async function runTest() {
    try {
        await scraper.init();
        const result = await scraper.scrapeASIN('B0GQVPPGGK', () => {});
        fs.writeFileSync('result.json', JSON.stringify(result, null, 2), 'utf8');
        logFile.write("Done. Saved to result.json\n");
    } catch (e) {
        logFile.write("Error: " + e.stack + "\n");
    } finally {
        await scraper.close();
        logFile.end();
        process.exit(0);
    }
}

runTest();
