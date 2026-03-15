const chokidar = require('chokidar');
const path = require('path');
const logger = require('./logger');
const orchestrator = require('./orchestrator');

function startWatcher() {
    const watchFolder = path.join(__dirname, 'watch');

    const watcher = chokidar.watch(watchFolder, {
        ignored: (path, stats) => stats?.isFile() && !path.endsWith('.csv') && !path.endsWith('.txt'),
        persistent: true,
        ignoreInitial: false,
        depth: 0
    });

    logger.info(`[WATCHER] Monitoring folder: ${watchFolder}`);

    watcher.on('add', (filePath) => {
        const fileName = path.basename(filePath);
        if (fileName.endsWith('.csv')) {
            logger.info(`[WATCHER] New CSV detected: ${fileName}`);
            // Wait for file to be fully written
            setTimeout(() => {
                orchestrator.addToQueue(filePath, 'Drop-Folder Trigger');
            }, 3000);
        } else {
            if (fileName !== 'DROP_CSV_FILES_HERE.txt') {
                logger.warn(`[WATCHER] Non-CSV file ignored: ${fileName}`);
            }
        }
    });

    watcher.on('error', error => logger.error(`[WATCHER] Error: ${error}`));
}

module.exports = startWatcher;
