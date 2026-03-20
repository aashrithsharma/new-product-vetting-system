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

            let credentials;
            if (process.env.GOOGLE_CREDENTIALS) {
                // Remove accidental prefix characters like dashes the user might have pasted
                let cleanCreds = process.env.GOOGLE_CREDENTIALS.trim();
                if (cleanCreds.startsWith('-')) cleanCreds = cleanCreds.substring(1).trim();
                credentials = JSON.parse(cleanCreds);
            } else {
                let credString = config.google.credentialsPath || '';
                credString = credString.trim();
                if (credString.startsWith('-')) credString = credString.substring(1).trim();
                
                try {
                    credentials = JSON.parse(credString);
                } catch (e) {
                    // If it contains "service_account", they pasted broken JSON into Vercel, don't read from file
                    if (credString.includes('service_account')) {
                        throw new Error('Google Credentials JSON appears slightly malformed. Make sure it starts with {');
                    }
                    credentials = JSON.parse(fs.readFileSync(credString, 'utf8'));
                }
            }
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
        const sheetTitle = 'Sheet1'; // Default and only sheet

        try {
            await this.init();

            // 1. Prepare Horizontal Data
            const dateStr = new Date().toLocaleString();
            
            // Define Headers
            const headers = [
                'Date',
                'ASIN',
                'Title',
                'Brand',
                'Price',
                'Stars',
                'Reviews',
                'Status',
                'Form',
                'Image',
                'Product Link'
            ];

            // Check if sheet is empty to write headers
            const check = await this.sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetTitle}!A1:Z1`
            });

            const hasHeaders = check.data.values && check.data.values[0] && check.data.values[0].length > 0;
            
            if (!hasHeaders) {
                await this.sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${sheetTitle}!A1`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [headers] }
                });

                // Format Headers
                const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
                const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetTitle) || spreadsheet.data.sheets[0];
                const sheetId = sheet.properties.sheetId;

                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: {
                        requests: [
                            {
                                repeatCell: {
                                    range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                                    cell: {
                                        userEnteredFormat: {
                                            backgroundColor: { red: 0.1, green: 0.2, blue: 0.4 },
                                            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
                                            horizontalAlignment: 'CENTER'
                                        }
                                    },
                                    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
                                }
                            },
                            {
                                updateSheetProperties: {
                                    properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                                    fields: 'gridProperties.frozenRowCount'
                                }
                            }
                        ]
                    }
                });
            }

            // 2. Prepare Rows for Appending
            const rows = results.map(r => {
                const d = r.data || {};
                return [
                    dateStr,
                    r.asin || 'N/A',
                    d.title || 'N/A',
                    d.brand || 'N/A',
                    d.price || r.price || 'N/A',
                    d.stars || 'N/A',
                    d.reviews || 'N/A',
                    r.status || 'UNKNOWN',
                    d.form || 'N/A',
                    d.imageUrl ? `=IMAGE("${d.imageUrl}")` : 'N/A',
                    r.originalUrl || d.originalUrl || 'N/A'
                ];
            });

            // 3. Append Data
            await this.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetTitle}!A1`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: { values: rows }
            });

            logger.info(`[SHEETS] Appended ${results.length} results to ${sheetTitle}`);

            // 4. Global Row Formatting (Center Align)
            const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
            const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetTitle) || spreadsheet.data.sheets[0];
            const sheetId = sheet.properties.sheetId;

            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: {
                    requests: [
                        {
                            repeatCell: {
                                range: { sheetId, startColumnIndex: 0, endColumnIndex: headers.length },
                                cell: {
                                    userEnteredFormat: {
                                        verticalAlignment: 'MIDDLE',
                                        wrapStrategy: 'WRAP'
                                    }
                                },
                                fields: 'userEnteredFormat(verticalAlignment,wrapStrategy)'
                            }
                        },
                        // Set width for Title (Col C) and Link (Col J)
                        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 300 }, fields: 'pixelSize' } },
                        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } }
                    ]
                }
            });

            return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`;
        } catch (error) {
            logger.error(`[SHEETS] Writing error: ${error.message}`);
            return null;
        }
    }
}

module.exports = new SheetsService();
