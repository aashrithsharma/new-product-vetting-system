const app = require('./server');
const startScheduler = require('./scheduler');
const logger = require('./logger');
const config = require('./config');

logger.info('==========================================');
logger.info('   Amazon Competitor Intelligence System   ');
logger.info('==========================================');

// Start Express Server
const port = config.port;
app.listen(port, '0.0.0.0', () => {
    logger.info(`[SERVER] Running at http://localhost:${port}`);

    // Start Scheduler
    startScheduler();

    logger.info('[SYSTEM] All systems operational. Waiting for triggers...');
});
