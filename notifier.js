const axios = require('axios');
const logger = require('./logger');

/**
 * Sends Slack notifications via Webhook
 */
async function sendNotification(summary) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
        logger.info('[NOTIFIER] No SLACK_WEBHOOK_URL set, skipping notification.');
        return;
    }

    const { status, trigger, total, success, failed, blocked, duration, sheetLink, failedAsins } = summary;

    const isSuccess = status === 'complete' && failed === 0 && blocked === 0;
    const emoji = isSuccess ? '🟢' : '🟠';
    const title = isSuccess ? 'Scrape Run Complete' : 'Scrape Run Partial/Failure';

    let message = `${emoji} *${title}* (${trigger})\n\n`;
    message += `• *Total:* ${total}\n`;
    message += `• *Succeeded:* ${success}\n`;
    message += `• *Failed:* ${failed}\n`;
    message += `• *Blocked:* ${blocked}\n`;
    message += `• *Duration:* ${duration.toFixed(2)} minutes\n`;

    if (sheetLink) {
        message += `\n📊 <${sheetLink}|Open Google Sheet>`;
    }

    if (!isSuccess && failedAsins && failedAsins.length > 0) {
        message += `\n\n⚠️ *Issues:*`;
        failedAsins.forEach(item => {
            message += `\n- ${item.asin}: ${item.reason}`;
        });
    }

    try {
        await axios.post(webhookUrl, { text: message });
        logger.info('[NOTIFIER] Slack notification sent.');
    } catch (error) {
        logger.error(`[NOTIFIER] Error sending Slack notification: ${error.message}`);
    }
}

module.exports = { sendNotification };
