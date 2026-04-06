const orchestrator = require('./orchestrator');
require('dotenv').config();

async function runTest() {
    console.log('--- STARTING INTERNAL TEST RUN: POOL TEST KIT ---');
    const runId = await orchestrator.startRun({
        products: [{ asin: 'B0BZV6W8X9', domain: 'amazon.com' }],
        formats: ['csv'],
        writeToSheets: true,
        vettingEnabled: true,
        ideaName: '9 in 1 water Test Kit for pool',
        triggerSource: 'internal_test_pool_kit'
    });
    
    console.log(`Run started: ${runId}`);
    
    let complete = false;
    while (!complete) {
        const state = orchestrator.getRunState(runId);
        if (state && state.isComplete) {
            console.log('\nRun Complete!');
            console.log(`Sheet Tab Created: ${state.ideaName}`);
            complete = true;
        } else if (state && state.status === 'failed') {
            console.log('\nRun FAILED!');
            complete = true;
        } else {
            process.stdout.write('.');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

runTest().catch(console.error);
