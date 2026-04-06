const orchestrator = require('./orchestrator');
const logger = require('./logger');

async function runBatch() {
    const asins = [
        'B008UMFVZE', 
        'B008UMEF2O', 
        'B0017T0IZ0', 
        'B07G8KWGSK', 
        'B007ZU4I2E', 
        'B08DBRPT5K'
    ];

    logger.info(`[BATCH TEST] Starting vetting for ${asins.length} products...`);

    try {
        const runId = await orchestrator.startRun({
            products: asins.map(asin => ({ asin })),
            vettingEnabled: true,
            writeToSheets: true,
            ideaName: 'Pool Clarifiers - Vetting Batch',
            triggerSource: 'Final Verification Test'
        });

        logger.info(`[BATCH TEST] Run started with ID: ${runId}. Monitoring for completion...`);

        // Check status every 30 seconds
        const checkInterval = setInterval(() => {
            try {
                const run = orchestrator.getRunState(runId);
                if (!run) {
                    logger.error('[BATCH TEST] Run state is null/undefined for ID: ' + runId);
                    return;
                }

                const completed = run.results ? run.results.length : 0;
                const total = run.totalAsins || 0;
                logger.info(`[BATCH TEST] Progress: ${completed}/${total} completed.`);

                if (run.isComplete || completed >= total) {
                    clearInterval(checkInterval);
                    logger.info('[BATCH TEST] Run Finished!');
                    if (run.sheetLink) {
                        logger.info(`[BATCH TEST] RESULT SHEET: ${run.sheetLink}`);
                    }
                }
            } catch (err) {
                logger.error('[BATCH TEST] Monitor Error: ' + err.message);
            }
        }, 10000);

    } catch (error) {
        logger.error(`[BATCH TEST] Execution failed: ${error.message}`);
    }
}

runBatch();
