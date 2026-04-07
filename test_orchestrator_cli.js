require('dotenv').config();
const orchestrator = require('./orchestrator');

async function runTest() {
    console.log('Starting internal single ASIN run...');
    const startTime = Date.now();
    try {
        const runId = await orchestrator.startRun({
            products: [{ asin: 'B09CQJ6M6P', domain: 'amazon.com', originalUrl: 'https://www.amazon.com/dp/B09CQJ6M6P' }],
            formats: ['csv', 'xlsx'],
            writeToSheets: false, // Don't overwrite the user's sheets for a test
            vettingEnabled: true,
            ideaName: 'Internal Test',
            triggerSource: 'local_CLI'
        });
        
        console.log(`Run started with ID: ${runId}. Waiting for completion...`);
        
        let isComplete = false;
        while (!isComplete) {
            await new Promise(r => setTimeout(r, 2000));
            const state = orchestrator.getRunState(runId);
            if (!state) {
                console.log('Run state disappeared.');
                break;
            }
            
            if (state.logLines.length > 0) {
                const latestLog = state.logLines[state.logLines.length - 1];
                console.log(`Progress: ${state.completedAsins}/${state.totalAsins} | Last action: ${latestLog.message}`);
            }
            
            if (state.isComplete || state.status === 'failed' || state.status === 'cancelled') {
                console.log('\n\n--- RUN COMPLETE ---');
                console.log(`Final Status: ${state.status}`);
                console.log(`Duration: ${((Date.now() - startTime)/1000).toFixed(1)}s`);
                
                if (state.results.length > 0) {
                    console.log(`\nExtracted ${state.results.filter(r => r.status==='SUCCESS').length} valid competitors.`);
                    for (let i = 0; i < state.results.length; i++) {
                        const r = state.results[i];
                        if (r.status === 'SUCCESS') {
                            const d = r.data;
                            console.log(`\n[${i+1}] ASIN: ${r.asin}`);
                            console.log(`    Brand  : ${d.brand}`);
                            console.log(`    Price  : ${d.price}`);
                            console.log(`    BSR    : ${d.bsr}`);
                            console.log(`    Stars  : ${d.stars} (${d.reviews})`);
                            console.log(`    Dim    : ${d.dimensions}`);
                            console.log(`    Weight : ${d.weight}`);
                        }
                    }
                }
                isComplete = true;
            }
        }
    } catch (e) {
        console.error('\nTest crashed:', e);
    }
}

runTest();
