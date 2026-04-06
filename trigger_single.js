const http = require('http');

// Single ASIN test — system should auto-discover 5 competitors
const body = JSON.stringify({
    mode: 'asins',
    asins: ['B008UMFVZE'],  // <-- just ONE asin
    ideaName: 'Pool Clarifier - Single ASIN Test',
    vettingEnabled: true,
    writeToSheets: true
});

const auth = Buffer.from('admin:admin123').toString('base64');

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/scrape',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${auth}`
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        const j = JSON.parse(data);
        console.log('Run ID:', j.runId);
        console.log('Status:', j.status);
    });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(body);
req.end();
