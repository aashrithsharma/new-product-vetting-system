require('dotenv').config();
const express = require('express');

const path = require('path');
const orchestrator = require('./orchestrator');
const { parseAmazonUrl } = require('./urlParser');
const logger = require('./logger');
const config = require('./config');

const app = express();
app.use(express.json());

// Basic Authentication Middleware
const authMiddleware = (req, res, next) => {
    // FAIL-SAFE: Default to 'admin123' if the variable is missing or empty in Vercel
    const appPassword = (process.env.APP_PASSWORD || 'admin123').trim();
    
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const parts = Buffer.from(b64auth, 'base64').toString().split(':');
    const login = (parts[0] || '').toLowerCase().trim();
    const password = parts.slice(1).join(':').trim();

    if (login === 'admin' && password === appPassword) {
        return next();
    }

    const freshRealm = 'Secure Dashboard Audit ' + new Date().getTime();
    res.set('WWW-Authenticate', `Basic realm="${freshRealm}"`);
    res.status(401).send('Authentication required. Use admin / admin123');
};

app.use(authMiddleware);

app.use(express.static(path.join(__dirname, 'app_views'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Routes
app.get('/api/status', (req, res) => {
    res.json(orchestrator.getStatus());
});

app.post('/api/scrape', async (req, res) => {
    const { mode, writeToSheets, triggerSource } = req.body;
    const formats = req.body.formats || ['csv', 'xlsx']; // Keep formats from original code
    
    logger.info(`[SERVER] /api/scrape received request. Mode: ${mode}`);
    logger.info(`[SERVER] Request body: ${JSON.stringify(req.body)}`);

    const rawInputs = req.body.urls || req.body.asins || req.body.inputs || [];
    const inputArray = Array.isArray(rawInputs) 
        ? rawInputs 
        : (typeof rawInputs === 'string' ? rawInputs.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0) : []);

    logger.info(`[SERVER] Raw inputs identified (${inputArray.length}): ${JSON.stringify(inputArray)}`);

    if (inputArray.length === 0) {
        logger.error('[SERVER] No valid inputs provided in request body.');
        return res.status(400).json({ 
            error: 'No valid inputs provided. Please enter at least one ASIN or URL.',
            received: req.body 
        });
    }

    if (!mode || (mode !== 'asins' && mode !== 'urls')) {
        logger.error(`[SERVER] Invalid mode provided: ${mode}`);
        return res.status(400).json({ error: 'Invalid request — mode must be asins or urls.' });
    }

    try {
        let finalProducts = [];
        const limitedInputs = inputArray.slice(0, 10);
        let parserLogs = [];

        logger.info(`[SERVER] Proceeding with ${limitedInputs.length} inputs...`);

        for (let i = 0; i < limitedInputs.length; i++) {
            const input = limitedInputs[i];
            const parsed = require('./urlParser').parseInput(input);

            if (parsed) {
                finalProducts.push(parsed);
                logger.info(`[SERVER] Successfully parsed input [${i+1}]: ${parsed.asin}`);
            } else {
                logger.warn(`[SERVER] Could not parse input [${i+1}]: "${input}"`);
                parserLogs.push(`Could not extract ASIN from: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`);
            }
        }

        if (finalProducts.length === 0) {
            logger.error('[SERVER] Failed to extract any valid ASINs from the provided inputs.');
            return res.status(400).json({ 
                error: 'Could not extract any valid ASINs from your input. Please check the formats.',
                details: parserLogs
            });
        }

        logger.info(`[SERVER] Total valid ASINs for run: ${finalProducts.length}`);

        // Deduplicate and Normalize
        finalProducts = [...new Map(finalProducts.map(p => [p.asin, p])).values()];

        if (finalProducts.length === 0) {
            return res.status(400).json({ error: 'No valid ASINs found \u2014 please check your inputs (Format: /dp/B0... or raw ASIN).' });
        }

        function extractSheetId(input) {
            if (!input) return null;
            // Examples:
            // 1. Full URL: https://docs.google.com/spreadsheets/d/1abc123/edit#gid=0
            // 2. ID: 1abc123
            const match = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
            return match ? match[1] : input.trim();
        }

        const runId = await orchestrator.startRun({
            products: finalProducts,
            formats,
            writeToSheets,
            customSheetId: extractSheetId(req.body.customSheetId),
            triggerSource: 'Web App',
            vettingEnabled: req.body.vettingEnabled,
            ideaName: req.body.ideaName
        });


        // Add initial parser logs to the run
        const run = orchestrator.getRunState(runId);
        if (run) {
            run.logLines.push({
                timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
                type: 'INFO',
                message: `Parsed ${rawInputs.length} inputs:\n${parserLogs.join('\n')}`
            });
            run.logLines.push({
                timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
                type: 'INFO',
                message: `Starting optimized scrape of ${finalProducts.length} unique products...`
            });
        }

        logger.info(`[API] Extracted ASINs from inputs:\n${parserLogs.join('\n')}\nTotal: ${finalProducts.length} ASINs ready to scrape`);

        res.json({ runId, status: 'started' });
    } catch (error) {
        logger.error(`[API] Fatal error in route handler: ${error.message}`);
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/scrape/:runId/progress', async (req, res) => {
    const state = orchestrator.getRunState(req.params.runId);
    if (!state) return res.status(404).json({ error: 'Run not found' });
    
    // SERVERLESS AWAKE LOOP
    // Keeps background script running at 80% full speed by artificially delaying the HTTP response
    // Must remain strictly < 2000ms (client poll rate) to prevent Vercel container splitting
    if (process.env.VERCEL && !state.isComplete && state.status !== 'failed' && state.status !== 'cancelled') {
        const { delay } = require('./utils');
        await delay(1600);
    }

    res.json(state);
});

app.get('/api/scrape/:runId/download/:format', (req, res) => {
    const state = orchestrator.getRunState(req.params.runId);
    if (!state || !state.isComplete) return res.status(404).json({ error: 'Run not complete or not found' });

    const format = req.params.format;
    const filePath = state.outputs[format];

    if (!filePath) return res.status(404).json({ error: 'File format not found' });

    res.download(path.resolve(filePath));
});

app.delete('/api/scrape/:runId', (req, res) => {
    const success = orchestrator.cancelRun(req.params.runId);
    res.json({ success });
});

module.exports = app;
