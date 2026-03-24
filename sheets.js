const { google } = require('googleapis');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

/**
 * Google Sheets Service — Vertical Format (products as columns, attributes as rows)
 * Matches the white-background layout: Image row, Brand, ASIN, Link, Price, Stars, Reviews, Title
 */
class SheetsService {
    constructor() {
        this.auth = null;
        this.sheets = null;
    }

    async init(sheetId) {
        try {
            const spreadsheetId = sheetId || config.google.sheetId;
            if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID missing');

            let credentials;
            if (process.env.GOOGLE_CREDENTIALS) {
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
            logger.info(`[SHEETS] Google Sheets API initialized for Sheet: ${spreadsheetId}`);
        } catch (error) {
            logger.error(`[SHEETS] Initialization error: ${error.message}`);
            throw error;
        }
    }

    async writeResults(results, sheetId) {
        if (!results || results.length === 0) {
            logger.warn('[SHEETS] No results to write to Google Sheets');
            return null;
        }

        const spreadsheetId = sheetId || config.google.sheetId;
        if (!spreadsheetId) {
            logger.error('[SHEETS] No Spreadsheet ID provided and no default found in config');
            return null;
        }

        try {
            await this.init(spreadsheetId);

            // Fetch Spreadsheet Metadata
            const spreadsheetRes = await this.sheets.spreadsheets.get({ spreadsheetId });
            const sheetsList = spreadsheetRes.data.sheets || [];
            if (sheetsList.length === 0) throw new Error('No sheets found in the spreadsheet');

            const targetSheet = sheetsList.find(s => s.properties.title === 'Sheet1') || sheetsList[0];
            const sheetTitle = targetSheet.properties.title;
            const sheetIdInt = targetSheet.properties.sheetId;

            logger.info(`[SHEETS] Target sheet identified: "${sheetTitle}" (ID: ${sheetIdInt})`);

            // ── Row definitions (vertical layout) ──────────────────────────────
            // Each entry = one row in the sheet; products fill columns B, C, D...
            const rowDefs = [
                { label: 'Product Link -->',       key: 'link' },
                { label: '',                        key: '_image' },   // Image row (tall)
                { label: 'Form',                    key: 'form' },
                { label: 'Brand Name',              key: 'brand' },
                { label: 'ASIN',                    key: 'asin' },
                { label: 'Link',                    key: 'link' },
                { label: 'Selling Price during season', key: 'price' },
                { label: 'Sales/day during season', key: '_blank' },   // manual field
                { label: 'Stars',                   key: 'stars' },
                { label: 'Reviews',                 key: 'reviews' },
                { label: 'Title',                   key: 'title' },
            ];

            // ── Clear the sheet first so we always write fresh ─────────────────
            await this.sheets.spreadsheets.values.clear({
                spreadsheetId,
                range: `'${sheetTitle}'!A1:ZZ`,
            });

            // ── Build 2D values array ──────────────────────────────────────────
            // Rows = attributes, Columns = [A: label, B: product 1, C: product 2, ...]
            const sheetData = rowDefs.map(rowDef => {
                const cells = [rowDef.label]; // Column A = label

                for (const r of results) {
                    const d = r.data || {};
                    let val = '';

                    switch (rowDef.key) {
                        case 'link':
                            val = r.originalUrl || d.originalUrl || `https://www.amazon.com/dp/${r.asin}?psc=1`;
                            break;
                        case '_image':
                            // Use IMAGE() formula so the thumbnail shows inline
                            val = d.imageUrl ? `=IMAGE("${d.imageUrl}")` : '';
                            break;
                        case 'form':
                            val = d.form || 'N/A';
                            break;
                        case 'brand':
                            val = d.brand || 'N/A';
                            break;
                        case 'asin':
                            val = r.asin || 'N/A';
                            break;
                        case 'price':
                            val = d.price || 'N/A';
                            break;
                        case 'stars':
                            val = d.stars || 'N/A';
                            break;
                        case 'reviews':
                            val = d.reviews || 'N/A';
                            break;
                        case 'title':
                            val = d.title || 'N/A';
                            break;
                        case '_blank':
                        default:
                            val = '';
                    }

                    cells.push(val);
                }

                return cells;
            });

            // ── Write all data at once ─────────────────────────────────────────
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'${sheetTitle}'!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: sheetData },
            });

            logger.info(`[SHEETS] Wrote ${results.length} products (vertical) to "${sheetTitle}"`);

            // ── Formatting ────────────────────────────────────────────────────
            const numProducts = results.length; // number of product columns
            const numRows = rowDefs.length;

            const requests = [];

            // 1. Label column A — light grey background, bold, center
            requests.push({
                repeatCell: {
                    range: { sheetId: sheetIdInt, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: 1 },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
                            textFormat: { bold: true },
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE',
                            wrapStrategy: 'WRAP',
                        }
                    },
                    fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)'
                }
            });

            // 2. Header row (row 0) — cyan header bar for product columns (matching white layout)
            if (numProducts > 0) {
                requests.push({
                    repeatCell: {
                        range: { sheetId: sheetIdInt, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 1 + numProducts },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 0.0, green: 0.9, blue: 0.9 },  // cyan
                                textFormat: { bold: true },
                                horizontalAlignment: 'CENTER',
                                verticalAlignment: 'MIDDLE',
                            }
                        },
                        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
                    }
                });
            }

            // 3. Image row (row index 1) — tall row height for thumbnails
            requests.push({
                updateDimensionProperties: {
                    range: { sheetId: sheetIdInt, dimension: 'ROWS', startIndex: 1, endIndex: 2 },
                    properties: { pixelSize: 150 },
                    fields: 'pixelSize'
                }
            });

            // 4. "Selling Price" row (index 6) — bold text in product columns
            requests.push({
                repeatCell: {
                    range: { sheetId: sheetIdInt, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 1, endColumnIndex: 1 + numProducts },
                    cell: {
                        userEnteredFormat: {
                            textFormat: { bold: true },
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE',
                        }
                    },
                    fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)'
                }
            });

            // 5. All data cells — center align, middle vertical, wrap, white background
            requests.push({
                repeatCell: {
                    range: { sheetId: sheetIdInt, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 1, endColumnIndex: 1 + numProducts },
                    cell: {
                        userEnteredFormat: {
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE',
                            wrapStrategy: 'WRAP',
                        }
                    },
                    fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)'
                }
            });

            // 6. ASIN row (index 4) — blue hyperlink-style text
            requests.push({
                repeatCell: {
                    range: { sheetId: sheetIdInt, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 1 + numProducts },
                    cell: {
                        userEnteredFormat: {
                            textFormat: { foregroundColor: { red: 0.07, green: 0.36, blue: 0.73 }, underline: true },
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE',
                        }
                    },
                    fields: 'userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)'
                }
            });

            // 7. Title row (last row) — taller for wrapped text
            requests.push({
                updateDimensionProperties: {
                    range: { sheetId: sheetIdInt, dimension: 'ROWS', startIndex: numRows - 1, endIndex: numRows },
                    properties: { pixelSize: 180 },
                    fields: 'pixelSize'
                }
            });

            // 8. Column widths: A=200, product cols=160
            requests.push({
                updateDimensionProperties: {
                    range: { sheetId: sheetIdInt, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
                    properties: { pixelSize: 210 },
                    fields: 'pixelSize'
                }
            });

            if (numProducts > 0) {
                requests.push({
                    updateDimensionProperties: {
                        range: { sheetId: sheetIdInt, dimension: 'COLUMNS', startIndex: 1, endIndex: 1 + numProducts },
                        properties: { pixelSize: 160 },
                        fields: 'pixelSize'
                    }
                });
            }

            // 9. Freeze the label column (A)
            requests.push({
                updateSheetProperties: {
                    properties: { sheetId: sheetIdInt, gridProperties: { frozenColumnCount: 1 } },
                    fields: 'gridProperties.frozenColumnCount'
                }
            });

            // 10. Borders on all cells
            requests.push({
                updateBorders: {
                    range: { sheetId: sheetIdInt, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: 1 + numProducts },
                    top:    { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                    bottom: { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                    left:   { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                    right:  { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                    innerHorizontal: { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                    innerVertical:   { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                }
            });

            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                resource: { requests },
            });

            logger.info(`[SHEETS] Formatting applied successfully`);

            return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetIdInt}`;
        } catch (error) {
            logger.error(`[SHEETS] Writing error: ${error.message}`);
            return null;
        }
    }
}

module.exports = new SheetsService();
