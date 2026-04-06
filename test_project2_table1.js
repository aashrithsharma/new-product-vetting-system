const orchestrator = require('./orchestrator');
const logger = require('./logger');

async function testProject2Table1() {
    logger.info('Starting Project 2 - Table 1 Generation Test...');
    
    // Sample product: 9 in 1 water Test Kit for pool
    const products = [
        { asin: 'B00107039U', domain: 'www.amazon.com' } // Stable Pool Kit ASIN
    ];

    try {
        const runId = await orchestrator.startRun({
            products,
            writeToSheets: true,
            vettingEnabled: true,
            ideaName: '9 in 1 water Test Kit for pool', 
            customSheetId: process.env.GOOGLE_SHEET_ID
        });

        logger.info(`Run started: ${runId}. Waiting for completion...`);

        // Poll for completion
        const checkInterval = setInterval(async () => {
            const state = orchestrator.getRunState(runId);
            if (state.status === 'complete' || state.status === 'failed') {
                clearInterval(checkInterval);
                if (state.status === 'complete') {
                    logger.info(`SUCCESS! Sheet generated: ${state.sheetLink}`);
                    console.log(`\nYour Table 1 is ready at:\n${state.sheetLink}`);
                } else {
                    logger.error(`Run failed: ${state.logLines.slice(-1)[0].message}`);
                }
            } else {
                logger.info(`Status: ${state.status} (${state.completedAsins}/${state.totalAsins})`);
            }
        }, 5000);

    } catch (e) {
        logger.error(`Error: ${e.message}`);
    }
}

testProject2Table1();
