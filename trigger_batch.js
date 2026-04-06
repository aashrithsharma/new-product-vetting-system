const http = require('http');

const body = JSON.stringify({
    mode: 'asins',
    asins: ['B008UMFVZE', 'B008UMEF2O', 'B0017T0IZ0', 'B07G8KWGSK', 'B007ZU4I2E', 'B08DBRPT5K'],
    ideaName: 'Pool Clarifiers - Table3 Test',
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
        try {
            const parsed = JSON.parse(data);
            console.log('Run ID:', parsed.runId);
            console.log('Response:', JSON.stringify(parsed, null, 2));
        } catch(e) {
            console.log('Raw response:', data);
        }
    });
});

req.on('error', (e) => console.error('Request error:', e.message));
req.write(body);
req.end();
