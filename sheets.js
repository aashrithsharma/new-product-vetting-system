const { google } = require('googleapis');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

/**
 * Google Sheets Service
 */
class SheetsService {
    constructor() {
        this.auth = null;
        this.sheets = null;
    }

    async init() {
        try {
            if (!config.google.sheetId) throw new Error('GOOGLE_SHEET_ID missing');

            const credentials = JSON.parse(fs.readFileSync(config.google.credentialsPath));
            this.auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            const authClient = await this.auth.getClient();
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
            logger.info('[SHEETS] Google Sheets API initialized');
        } catch (error) {
            logger.error(`[SHEETS] Initialization error: ${error.message}`);
            throw error;
        }
    }

    async writeResults(results) {
        const spreadsheetId = config.google.sheetId;
        const sheetTitle = 'Sheet1'; // Default sheet

        try {
            await this.init();

            // 1. Clear Sheet
            await this.sheets.spreadsheets.values.clear({
                spreadsheetId,
                range: sheetTitle
            });

            // 2. Prepare Vertical Data
            const rowDefinitions = [
                { label: 'Product Link', key: 'originalUrl' },
                { label: 'Product Image', key: 'imageUrl' },
                { label: 'Form', key: 'form' },
                { label: 'Brand Name', key: 'brand' },
                { label: 'ASIN', key: 'asin' },
                { label: 'Link', key: 'originalUrl' },
                { label: 'Selling Price', key: 'price' },
                { label: 'Stars', key: 'stars' },
                { label: 'Reviews', key: 'reviews' },
                { label: 'Title', key: 'title' }
            ];

            const values = [];
            rowDefinitions.forEach((def, rowIndex) => {
                const row = [def.label];
                results.forEach(r => {
                    let val = 'N/A';
                    if (def.key === 'originalUrl') {
                        val = r.originalUrl || '';
                    } else if (def.key === 'asin') {
                        val = r.asin || '';
                    } else {
                        val = r.data ? (r.data[def.key] || 'N/A') : 'N/A';
                    }

                    if (def.label === 'Product Image') {
                        const imgUrl = r.data?.imageUrl;
                        val = imgUrl ? `=IMAGE("${imgUrl}")` : '';
                    }

                    if (def.label === 'Selling Price') {
                        const asin = r.asin;
                        const priceVal = r.data?.price || r.price || 'N/A';
                        val = priceVal;
                        logger.info(`Sheets price for ${asin}: ${priceVal}`);
                    }

                    row.push(val);
                });
                values.push(row);
            });

            // 3. Write Data
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetTitle}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });

            // 4. Formatting (Batch Update)
            const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
            const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetTitle) || spreadsheet.data.sheets[0];
            const sheetId = sheet.properties.sheetId;

            const requests = [
                // Set Label Column Width (A) to 150px
                { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
                // Set Data Column Widths (B+) to 200px
                { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: results.length + 1 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
                // Set Image Row Height (Row 2) to 100px
                { updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
                // Label Column Style (Column A)
                {
                    repeatCell: {
                        range: { sheetId, startColumnIndex: 0, endColumnIndex: 1, startRowIndex: 0, endRowIndex: rowDefinitions.length },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 0.106, green: 0.169, blue: 0.294 }, // #1B2B4B
                                textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
                                horizontalAlignment: 'LEFT',
                                verticalAlignment: 'MIDDLE'
                            }
                        },
                        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
                    }
                },
                // Data Columns Global Style (Wrap, Alignment)
                {
                    repeatCell: {
                        range: { sheetId, startColumnIndex: 1, endColumnIndex: results.length + 1, startRowIndex: 0, endRowIndex: rowDefinitions.length },
                        cell: {
                            userEnteredFormat: {
                                wrapStrategy: 'WRAP',
                                horizontalAlignment: 'CENTER',
                                verticalAlignment: 'MIDDLE'
                            }
                        },
                        fields: 'userEnteredFormat(wrapStrategy,horizontalAlignment,verticalAlignment)'
                    }
                }
            ];

            // Conditional Pricing Formatting
            results.forEach((r, idx) => {
                const colIdx = idx + 1;
                const priceVal = r.data?.price || r.price || 'N/A';
                const isNA = priceVal === 'N/A';
                
                requests.push({
                    repeatCell: {
                        range: { sheetId, startColumnIndex: colIdx, endColumnIndex: colIdx + 1, startRowIndex: 6, endRowIndex: 7 }, // Row 7
                        cell: {
                            userEnteredFormat: {
                                textFormat: { 
                                    bold: true,
                                    foregroundColor: isNA ? { red: 1, green: 0, blue: 0 } : { red: 0, green: 0, blue: 0 }
                                }
                            }
                        },
                        fields: 'userEnteredFormat.textFormat(bold,foregroundColor)'
                    }
                });
            });

            await this.sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });

            await this.updateHistory(results);
            return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;
        } catch (error) {
            logger.error(`[SHEETS] Writing error: ${error.message}`);
            return null;
        }
    }

    async updateHistory(results) {
        // Keep history simple as per baseline but ensures it doesn't break
        const spreadsheetId = config.google.sheetId;
        const historyTitle = 'All Runs History';

        try {
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: { requests: [{ addSheet: { properties: { title: historyTitle } } }] }
            }).catch(() => { });

            const check = await this.sheets.spreadsheets.values.get({ spreadsheetId, range: `${historyTitle}!A1:A1` });
            if (!check.data.values) {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${historyTitle}!A1`,
                    valueInputOption: 'RAW',
                    resource: { values: [['Run Date', 'Run ID', 'ASIN', 'Title', 'Brand', 'Price', 'Status']] }
                });
            }

            const runId = Date.now().toString();
            const dateStr = new Date().toISOString().split('T')[0];
            const historyRows = results.map(r => [
                dateStr, runId, r.asin, r.data?.title || 'N/A', r.data?.brand || 'N/A', r.data?.price || 'N/A', r.status
            ]);

            await this.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${historyTitle}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: historyRows }
            });
        } catch (e) {
            logger.error(`[SHEETS] History update error: ${e.message}`);
        }
    }
}

module.exports = new SheetsService();
