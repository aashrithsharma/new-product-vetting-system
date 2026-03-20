require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3000,
    schedule: {
        cron: process.env.SCRAPE_SCHEDULE || '0 7 * * *',
        timezone: process.env.SCRAPE_TIMEZONE || 'America/New_York'
    },
    google: {
        sheetId: process.env.GOOGLE_SHEET_ID,
        credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials/google-service-account.json',
    },
    // Slack removed
    /*
    slack: {
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
    },
    */
    scraper: {
        batchSize: parseInt(process.env.BATCH_SIZE) || 25,
        concurrency: parseInt(process.env.CONCURRENCY) || 10, // Process 10 ASINs in parallel by default
        relaunchThreshold: 50, // Keep browser longer in parallel mode
        minDelay: 28000,
        maxDelay: 32000,
        retryDelay: parseInt(process.env.RETRY_DELAY_MS) || 10000,
        defaultDomain: process.env.DEFAULT_AMAZON_DOMAIN || 'amazon.com',
        userAgentPool: require('./userAgents')
    }
};
