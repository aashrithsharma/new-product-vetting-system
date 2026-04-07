const { google } = require('googleapis');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

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

    async writeResults(results, sheetId, vettingResults = null, ideaName = "Idea") {
        if (!results || results.length === 0) {
            logger.warn('[SHEETS] No results to write to Google Sheets');
            return null;
        }

        const spreadsheetId = sheetId || config.google.sheetId;
        try {
            await this.init(spreadsheetId);
            const spreadsheetRes = await this.sheets.spreadsheets.get({ spreadsheetId });
            const sheetsList = spreadsheetRes.data.sheets || [];

            // REQUIREMENT UPDATED: Tab uniqueness is critical. Put timestamp at the START.
            const now = new Date();
            const timestamp = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
            const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
            
            // Format: "[15:23] Short Category Name"
            let shortName = String(ideaName).split(' > ').pop(); // Just take the last part of category
            if (shortName.length > 50) shortName = shortName.substring(0, 50) + '...';
            
            let targetSheetTitle = `[${timestamp}] ${shortName}`;
            // Clean up for Google Sheets
            targetSheetTitle = targetSheetTitle.substring(0, 100).replace(/[\[\]\?\*\/\\\:]/g, '');

            let targetSheetId;
            const existingTarget = sheetsList.find(s => s.properties.title === targetSheetTitle);
            
            if (!existingTarget) {
                targetSheetId = Math.floor(Math.random() * 10000000);
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: {
                        requests: [
                            { addSheet: { properties: { sheetId: targetSheetId, title: targetSheetTitle, index: 0 } } },
                            { updateSheetProperties: { fields: "index", properties: { sheetId: targetSheetId, index: 0 } } }
                        ]
                    }
                });
                logger.info(`[SHEETS] Created new target tab: ${targetSheetTitle}`);
            } else {
                targetSheetId = existingTarget.properties.sheetId;
                logger.info(`[SHEETS] Using existing target tab: ${targetSheetTitle}`);
                // Clear and move to front
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: {
                        requests: [
                            { updateSheetProperties: { fields: "index", properties: { sheetId: targetSheetId, index: 0 } } }
                        ]
                    }
                });
                await this.sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${targetSheetTitle}'!A1:ZZ1000` });
            }


            // Clear existing content and unmerge
            await this.sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${targetSheetTitle}'!A1:ZZ1000` });
            try {
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: { requests: [{ unmergeCells: { range: { sheetId: targetSheetId } } }] }
                });
            } catch(e) {}


            // === ASSEMBLE VALUES ===
            const values = [];
            const ai = vettingResults && vettingResults.analysis ? vettingResults.analysis : null;
            const financials = vettingResults && vettingResults.financials ? vettingResults.financials : null;
            
            // SECTION 1 — SIDE BY SIDE COMPARISON
            const comparisonStartRow = values.length + 1;
            values.push(['SECTION 1 — COMPETITIVE COMPARISON (Side by Side)', '', '', '', '', '', '', '']); 
            
            const labels = [
                'PRODUCT DESIGNATION',
                'Product Image', 
                'Brand Name', 
                'ASIN', 
                'Selling Price', 
                'Rating', 
                'Reviews', 
                'Badge / BSR', 
                'Dimensions L×W×H',
                'Item Weight',
                'Est. Units/day', 
                'Positioning / Tier', 
                'Title (Hover/Click)',
                'Link'
            ];
            
            const grid = labels.map(l => [l]);
            
            for (let i = 0; i < Math.min(results.length, 6); i++) {
                const r = results[i];
                const d = r.data || {};
                
                let tier = 'N/A';
                if (ai && ai.classifications) {
                    const match = ai.classifications.find(c => 
                        (c.brand && d.brand && c.brand.toLowerCase() === d.brand.toLowerCase()) || 
                        (c.asin === d.asin)
                    );
                    if (match) tier = match.tier;
                }

                const fNA = (val) => (val === 'N/A' || !val) ? '-' : val;

                grid[0].push(i === 0 ? 'COLUMN 1 — INPUT PRODUCT' : `COLUMN ${i + 1} — COMPETITOR`);
                grid[1].push(d.imageUrl ? `=IMAGE("${d.imageUrl}")` : '-');
                grid[2].push(fNA(d.brand));
                grid[3].push(fNA(d.asin));
                grid[4].push(fNA(d.price));
                grid[5].push((d.stars && d.stars !== 'N/A') ? `★${d.stars}` : '-');
                grid[6].push(fNA(d.reviews));
                grid[7].push((d.boughtPastMonth && d.boughtPastMonth !== 'N/A') ? d.boughtPastMonth : fNA(d.bsr));
                grid[8].push(fNA(d.dimensions));
                grid[9].push(fNA(d.weight));
                
                // --- INDIVIDUAL SALES ESTIMATION ---
                let estSales = '-';
                if (d.boughtPastMonth && d.boughtPastMonth !== 'N/A') {
                    const m = d.boughtPastMonth.match(/([\d,K.]+)\+/i);
                    if (m) {
                        let val = m[1].replace(/,/g, '').replace(/K/i, '000');
                        estSales = `~${Math.floor(parseFloat(val) / 30)} / day`;
                    } else if (d.boughtPastMonth.toLowerCase().includes('bought in past month')) {
                        const m2 = d.boughtPastMonth.match(/(\d[\d,]*)/);
                        if (m2) estSales = `~${Math.floor(parseFloat(m2[1].replace(/,/g, '')) / 30)} / day`;
                    }
                }
                
                if (estSales === 'N/A' && d.bsr && d.bsr !== 'N/A') {
                    const bsrNum = parseInt(String(d.bsr).replace(/[^0-9]/g, ''));
                    if (!isNaN(bsrNum)) {
                        // Import locally to avoid external dependency issues in this tool call
                        const { estimateDailySales } = require('./bsr');
                        const sales = estimateDailySales(bsrNum);
                        if (sales !== 'N/A') estSales = `~${sales} / day`;
                    }
                }

                grid[10].push(estSales === 'N/A' && i === 0 && ai ? `~${Math.floor(ai.estimatedUnitsPerDay)} / day` : estSales);
                grid[11].push(tier);
                grid[12].push(d.title || 'N/A');
                grid[13].push(d.url || `https://www.amazon.com/dp/${d.asin}`);
            }
            
            values.push(...grid);
            values.push([]); // Space
            values.push([]); // Space

            // SECTION 2 — Intelligence Brief (Condensed)
            const briefStartRow = values.length + 1;
            if (ai) {
                values.push(['SECTION 3 — Market Intelligence Brief', '', '', '', '', '', '', '']); 
                values.push(['MARKET ANALYSIS SUMMARY', '', '', '', 'STRATEGIC RECOMMENDATIONS', '', '', '']);
                values.push([ai.intelligenceBrief || 'N/A', '', '', '', `Target Price: $${ai.targetPrice || 'N/A'}\nSeasonality: ${ai.seasonality || 'N/A'} days\nFormat: ${ai.formatResearch || 'N/A'}`, '', '', '']);
                values.push([]);
            }

            // SECTION 3 - PRICE LADDER (Unit Economics — Table 1)
            const priceLadderStartRow = values.length + 1; 
            values.push(['SECTION 3 — UNIT ECONOMICS & PRICE LADDER (Table 1)', '', '', '', '', '', '', '']); 
            
            // Header for Table 1 (Row 1 of section)
            values.push([
                `${ideaName} COGS`, 
                'Ship By Amazon to Customer', 
                'Supplier to Amazon Warehouse', 
                'Referral Fee', 
                'Storage Fee + Inbounding cost', 
                'Selling Price', 
                'Net Profit', 
                'Gross Margin',
                'Select Target'
            ]); 
            
            let ladderStart = values.length + 1;
            let ladderEnd = ladderStart;
            
            if (financials) {
                const cogs = financials.targetCogs || 5.00;
                const fba = financials.fbaFee || 4.50;
                const supplierToAmazon = financials.supplierToAmazon || 1.25;
                const storageAndInbound = financials.storageAndInbound || 1.50;

                // Create a price ladder around target
                const targetPrice = financials.annualMetrics?.regularPrice || (cogs * 3);
                let basePrice = Math.floor(targetPrice - 10);
                if (basePrice < 4.99) basePrice = 4.99;

                let closestIdx = 0;
                let minDiff = 9999;
                for (let i = 0; i < 26; i++) {
                    const diff = Math.abs((basePrice + i) - targetPrice);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }
                
                ladderEnd = ladderStart + 25;

                for (let i = 0; i < 26; i++) {
                    const rowNum = values.length + 1;
                    const currentPrice = basePrice + i; 
                    const dropdownValue = (i === closestIdx) ? 'Regular Price' : '';
                    
                    values.push([
                        cogs, 
                        fba, 
                        supplierToAmazon, 
                        `=F${rowNum}*0.15`, 
                        storageAndInbound, 
                        currentPrice, 
                        `=F${rowNum}-A${rowNum}-B${rowNum}-C${rowNum}-D${rowNum}-E${rowNum}`, 
                        `=IF(F${rowNum}>0, G${rowNum}/F${rowNum}, 0)`,
                        dropdownValue
                    ]);
                }
            } else {
                values.push(['Financial modeling pending...', '', '', '', '', '', '', '', '']);
            }
            values.push([]); // Space
            values.push([]); // Space

            // SECTION 4 - PRODUCT SUMMARY METRICS (Table 2)
            const table2StartRow = values.length + 1; 
            values.push(['TABLE 2 — PRODUCT SUMMARY METRICS (Annual Business Case)', '', '', '', '', '', '', '', '', '', '', '']); 

            // Robust data gathering for Table 2
            let m = financials?.annualMetrics || {};
            let currentCogs = financials?.targetCogs || 0;
            const mostLikelyUnits = ai?.estimatedUnitsPerDay || 25;
            const fallbackPrice = ai?.targetPrice || 29.99;
            
            if (!m.retRate) {
                m.retRate = 0.025;
                m.leadTimeDays = 60;
                currentCogs = fallbackPrice * 0.35;
            }

            const table2Headers = [
                'Average inventory (Pack) holding every month', 'Product Name', 'Revenue', 'Return rate', 'Gross Margin', 
                'Ad Spend', 'Average Inventory value', 'Baseball Category', 'Lead Time (in days)', 'ROIC', 
                'Net Margin after ads', 'Expected Annual Contribution Margin ($)'
            ];

            const t3DataStartPredict = table2StartRow + 9;
            const t3DataEndPredict = t3DataStartPredict + 100; // Safe upper bound for formula summation

            const t2DataRow = table2StartRow + 2;

            const table2Data = [
                `=${mostLikelyUnits} * 182.5`, 
                ideaName, 
                `=SUMIF($H$${t3DataStartPredict}:$H$${t3DataEndPredict}, "Most Likely Scenario", $F$${t3DataStartPredict}:$F$${t3DataEndPredict})`, 
                m.retRate, 
                `=IF(COUNTIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price")>0, SUMIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price", $H$${ladderStart}:$H$${ladderEnd}), ${m.grossMarginPct || 0.35})`, 
                `=C${t2DataRow} * 0.20`, 
                `=A${t2DataRow} * A${ladderStart}`, 
                `=IF(C${t2DataRow}>=2500000, "Homerun", IF(C${t2DataRow}>=1500000, "Triple", IF(C${t2DataRow}>=750000, "Double", IF(C${t2DataRow}>=250000, "Single", "Less Than a Single"))))`, 
                m.leadTimeDays || 60, 
                `=IF(G${t2DataRow}>0, (L${t2DataRow}/G${t2DataRow})*100, 0)`, 
                `=(E${t2DataRow}*(1-D${t2DataRow})) - 0.20`, 
                `=C${t2DataRow} * K${t2DataRow}`
            ];
            
            values.push(table2Headers);
            values.push(table2Data);

            // Summary Callouts
            values.push([`=A${ladderStart}`, 0.30, `=C${t2DataRow}`, '<-- Total Annual Revenue', '', '', '', '', '', '', '', '']);
            values.push([`^ ${ideaName} Cogs per unit`, 'Desired Margin', '', '', '', '', '', '', '', '', '', '']);
            values.push([]); // Space
            values.push([]); // Space

            // SECTION 5 — TABLE 3: VOLUME SCENARIOS
            const table3StartRow = values.length + 1;
            values.push(['TABLE 3 — VOLUME SCENARIOS (Expected Units Per Day)', '', '', '', '', '', '', '']);

            const t3Headers = [
                'Expected Units We Can Sell Per Day',
                'Selling Price',
                'Daily Revenue',
                'Number of Days to Sell in a Year',
                'Total Annual Unit Volume',
                'Expected Annual Revenue',
                'Percentage of Total Annual Revenue',
                'Scenario Label'
            ];
            values.push(t3Headers);

            // Track row indices for Most Likely and Best Case for formatting
            const mostLikelyRowIndices = [];
            const bestCaseRowIndices = [];

            const scenarios = financials?.scenarios || [];
            const regularPrice = financials?.annualMetrics?.regularPrice || (ai?.targetPrice || 22.99);
            const days365 = 365;
            const denominatorRevenue = 25000000;

            scenarios.forEach((s, idx) => {
                const rowNum = values.length + 1; // 1-indexed for tracking
                let scenarioLabel = '';
                if (s.isMostLikely) {
                    scenarioLabel = 'Most Likely Scenario';
                    mostLikelyRowIndices.push(values.length); // 0-indexed
                }
                if (s.isBestCase) {
                    scenarioLabel = 'Best Case Scenario';
                    bestCaseRowIndices.push(values.length); // 0-indexed
                }
                values.push([
                    s.unitsPerDay,
                    `=IF(COUNTIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price")>0, SUMIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price", $F$${ladderStart}:$F$${ladderEnd}), ${s.sellingPrice || regularPrice})`,
                    `=$A${rowNum}*$B${rowNum}`,
                    s.daysPerYear || days365,
                    `=$A${rowNum}*$D${rowNum}`,
                    `=$C${rowNum}*$D${rowNum}`,
                    `=$F${rowNum}/${denominatorRevenue}`,
                    scenarioLabel
                ]);
            });

            // If no scenarios, generate a basic fallback table
            if (scenarios.length === 0) {
                const fallbackPrice = ai?.targetPrice || 22.99;
                const mostLikelyUnits = ai?.estimatedUnitsPerDay || 25;
                const bestCaseUnits = Math.max(mostLikelyUnits * 3, 25);
                
                let tableCeiling = Math.round(bestCaseUnits);
                if (tableCeiling % 2 === 0) tableCeiling += 1;

                for (let u = 1; u <= tableCeiling; u += 2) {
                    const rowNum = values.length + 1;
                    let label = '';
                    if (Math.abs(u - mostLikelyUnits) <= 1) {
                        label = 'Most Likely Scenario';
                        mostLikelyRowIndices.push(values.length);
                    }
                    if (u === tableCeiling) {
                        label = 'Best Case Scenario';
                        bestCaseRowIndices.push(values.length);
                    }
                    values.push([
                        u, 
                        `=IF(COUNTIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price")>0, SUMIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price", $F$${ladderStart}:$F$${ladderEnd}), ${fallbackPrice})`, 
                        `=$A${rowNum}*$B${rowNum}`, 
                        365, 
                        `=$A${rowNum}*$D${rowNum}`, 
                        `=$C${rowNum}*$D${rowNum}`, 
                        `=$F${rowNum}/${denominatorRevenue}`, 
                        label
                    ]);
                }
            }

            logger.info(`[SHEETS] Final Write — Total Rows: ${values.length}, T3 mostLikely rows: ${JSON.stringify(mostLikelyRowIndices)}, bestCase rows: ${JSON.stringify(bestCaseRowIndices)}`);
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'${targetSheetTitle}'!A1`, 
                valueInputOption: 'USER_ENTERED',
                resource: { values },
            });

            // === FORMATTING ===
            const requests = [];
            const sheetId = targetSheetId;

            // Global Style
            requests.push({
                repeatCell: {
                    range: { sheetId, startRowIndex: 0, endRowIndex: values.length + 5, startColumnIndex: 0, endColumnIndex: 10 },
                    cell: { 
                        userEnteredFormat: { 
                            backgroundColor: { red: 1, green: 1, blue: 1 }, 
                            textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 }, fontSize: 10, fontFamily: 'Outfit' }, 
                            verticalAlignment: 'MIDDLE' 
                        } 
                    },
                    fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)'
                }
            });

            const headerNavy = { red: 0.1, green: 0.1, blue: 0.3 };
            const headerTextWhite = { red: 1, green: 1, blue: 1 };
            const yellowHeader = { red: 1, green: 1, blue: 0 }; // Bright Yellow
            const greyHeader = { red: 0.4, green: 0.4, blue: 0.4 }; // Dark Grey
            const greyHeaderText = { red: 1, green: 0.9, blue: 0.6 }; // Cream/Yellow text on grey
            
            const greenCell = { red: 0.0, green: 1.0, blue: 0.0 }; // Bright Green from image
            const beigeCell = { red: 0.5, green: 0.5, blue: 0.2 }; // Tan/Beige for Net Profit
            const positiveMargin = { red: 0.7, green: 0.9, blue: 0.7 };
            const negativeColor = { red: 0.9, green: 0.3, blue: 0.3 };

            const mergeCells = (sR, eR, sC, eC) => {
                requests.push({ mergeCells: { range: { sheetId, startRowIndex: sR, endRowIndex: eR, startColumnIndex: sC, endColumnIndex: eC }, mergeType: 'MERGE_ALL' } });
            };

            // SECTION 1 — COMPARISON Formatting
            const compStart = comparisonStartRow - 1;
            mergeCells(compStart, compStart + 1, 0, 7); 
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: compStart, endRowIndex: compStart + 1, startColumnIndex: 0, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: headerNavy, textFormat: { bold: true, foregroundColor: headerTextWhite, fontSize: 12 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
            
            // Labels Column (A) for Comparison
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: compStart + 1, endRowIndex: compStart + 15, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Designation Row (Row 2 of Comparison) - Yellow
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: compStart + 1, endRowIndex: compStart + 2, startColumnIndex: 1, endColumnIndex: 7 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.9, blue: 0 }, textFormat: { bold: true }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });

            // SECTION 3 - UNIT ECONOMICS (Table 1 - Price Ladder)
            const plStart = priceLadderStartRow; // 0-indexed row for labels table starts here
            
            // Section Header
            mergeCells(plStart - 1, plStart, 0, 9);
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart - 1, endRowIndex: plStart, startColumnIndex: 0, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: headerNavy, textFormat: { bold: true, foregroundColor: headerTextWhite, fontSize: 12 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });

            // Table Header Colors (Labels row)
            [0, 1, 2, 5].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart, endRowIndex: plStart + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: yellowHeader, textFormat: { bold: true }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
            });
            [3, 4, 6, 7, 8].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart, endRowIndex: plStart + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: greyHeader, textFormat: { bold: true, foregroundColor: greyHeaderText }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
            });

            // Data Cell Backgrounds (Ladder rows)
            [0, 1, 5].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: greenCell, numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } }, fields: 'userEnteredFormat(backgroundColor,numberFormat)' } });
            });
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 6, endColumnIndex: 7 }, cell: { userEnteredFormat: { backgroundColor: beigeCell, numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat)' } });
            // Add column I visual layout + validation
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 8, endColumnIndex: 9 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.1, green: 0.5, blue: 0.3 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            requests.push({ setDataValidation: { range: { sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 8, endColumnIndex: 9 }, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Regular Price' }] }, showCustomUi: true, strict: false } } });

            requests.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 7, endColumnIndex: 8 }], booleanRule: { condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '0.3' }] }, format: { backgroundColor: positiveMargin, textFormat: { bold: true } } } } } });
            requests.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 6, endColumnIndex: 7 }], booleanRule: { condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '0' }] }, format: { backgroundColor: negativeColor, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 } } } } } } });

            // === TABLE 2 FORMATTING (A{table2StartRow} onwards) ===
            const t2Start = table2StartRow; // 0-indexed header
            const lightBlueHeader = { red: 0.85, green: 0.91, blue: 0.99 }; // #DAE8FC
            
            // Section Header
            mergeCells(t2Start - 1, t2Start, 0, 11);
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start - 1, endRowIndex: t2Start, startColumnIndex: 0, endColumnIndex: 12 }, cell: { userEnteredFormat: { backgroundColor: headerNavy, textFormat: { bold: true, foregroundColor: headerTextWhite, fontSize: 13 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });

            // Table 2 Header Style
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start, endRowIndex: t2Start + 1, startColumnIndex: 0, endColumnIndex: 12 }, cell: { userEnteredFormat: { backgroundColor: lightBlueHeader, textFormat: { bold: true }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)' } });
            
            // Format Table 2 Data (Row 2 of section)
            // Currency columns: C(Rev), F(Ad), G(InvVal), L(CM) -> 2, 5, 6, 11
            [2, 5, 6, 11].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 3, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' } } }, fields: 'userEnteredFormat(numberFormat)' } });
            });
            // Percent columns: D(Ret), E(GM), K(Net Margin) -> 3, 4, 10
            [3, 4, 10].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.00%' } } }, fields: 'userEnteredFormat(numberFormat)' } });
            });

            // HIGHLIGHT RULES TABLE 2
            // ROIC (Index 9 / Col J) Highlight - Row 2
            requests.push({
                addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: 9, endColumnIndex: 10 }], booleanRule: { condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '200' }] }, format: { backgroundColor: positiveMargin, textFormat: { bold: true } } } } }
            });

            // Gross Margin (Index 4 / Col E) Highlight - Row 2
            requests.push({
                addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: 4, endColumnIndex: 5 }], booleanRule: { condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '0.3' }] }, format: { backgroundColor: greenCell, textFormat: { bold: true } } } } }
            });

            // Row 3 Summary Cells (Index 2 of t2)
            // A (Cogs) - Yellow
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 2, endRowIndex: t2Start + 3, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: yellowHeader, numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat)' } });
            // B (Margin) - Green
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 2, endRowIndex: t2Start + 3, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { backgroundColor: greenCell, numberFormat: { type: 'PERCENT', pattern: '0.00%' }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat)' } });
            // Label Row for below A/B
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 3, endRowIndex: t2Start + 4, startColumnIndex: 0, endColumnIndex: 2 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 1.0, blue: 0.9 }, textFormat: { italic: true, fontSize: 8 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Contribution Margin (Col L / Index 11) in Orange
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 3, startColumnIndex: 11, endColumnIndex: 12 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.6, blue: 0 }, textFormat: { bold: true, fontSize: 12 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Total Annual Revenue callout (Col C / Index 2 Row 3) in Orange
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 2, endRowIndex: t2Start + 3, startColumnIndex: 2, endColumnIndex: 4 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.6, blue: 0 }, textFormat: { bold: true }, numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' } } }, fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)' } });

            // Column Widths for Table 2 (A:L)
            const table2ColWidths = [180, 180, 150, 100, 100, 120, 150, 120, 100, 120, 120, 200];
            table2ColWidths.forEach((w, i) => {
                requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } });
            });

            // === TABLE 3 FORMATTING ===
            const t3Start = table3StartRow - 1; // convert to 0-indexed
            const lightGrey = { red: 0.85, green: 0.85, blue: 0.85 };
            const yellowHighlight = { red: 1, green: 1, blue: 0 };
            const greenHighlight = { red: 0, green: 0.85, blue: 0 };
            const darkGreenText = { red: 0, green: 0.2, blue: 0 };

            // Table 3 Section Header (navy, full width 8 cols)
            mergeCells(t3Start, t3Start + 1, 0, 7);
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t3Start, endRowIndex: t3Start + 1, startColumnIndex: 0, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: headerNavy, textFormat: { bold: true, foregroundColor: headerTextWhite, fontSize: 13 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });

            // Table 3 Column Headers (row after section header)
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t3Start + 1, endRowIndex: t3Start + 2, startColumnIndex: 0, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: lightGrey, textFormat: { bold: true }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)' } });

            // Table 3 data rows — Currency format on cols B,C,F (indices 1,2,5)
            const t3DataStart = t3Start + 2;
            const t3DataEnd = values.length + 1;
            [1, 2, 5].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: t3DataStart, endRowIndex: t3DataEnd, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } }, fields: 'userEnteredFormat(numberFormat)' } });
            });
            // Percent format on col G (index 6)
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t3DataStart, endRowIndex: t3DataEnd, startColumnIndex: 6, endColumnIndex: 7 }, cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.00%' } } }, fields: 'userEnteredFormat(numberFormat)' } });
            // Center-align col A (units) and col D (days) and col E (annual vol)
            [0, 3, 4].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: t3DataStart, endRowIndex: t3DataEnd, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(horizontalAlignment)' } });
            });

            // YELLOW highlight for Most Likely rows
            mostLikelyRowIndices.forEach(rowIdx => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: yellowHighlight, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            });

            // GREEN highlight for Best Case rows
            bestCaseRowIndices.forEach(rowIdx => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: greenHighlight, textFormat: { bold: true, foregroundColor: darkGreenText } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            });

            // Row height for Table 3 header row — make it taller for wrapped text
            requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: t3Start + 1, endIndex: t3Start + 2 }, properties: { pixelSize: 50 }, fields: 'pixelSize' } });

            await this.sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
            logger.info(`[SHEETS] Layout complete: Comparison + Brief + Table 1 + Table 2 + Table 3 (Volume Scenarios).`);

            return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${targetSheetId}`;
        } catch (error) {
            const isPermissionError = error.message.includes('permission') || error.message.includes('403') || error.message.includes('caller does not have permission');
            const robotEmail = 'six10venturesvetting@six10-idea-vetting.iam.gserviceaccount.com';
            
            if (isPermissionError) {
                logger.error(`[SHEETS] CRITICAL: Permission Denied. You MUST share the spreadsheet (ID: ${spreadsheetId}) with the robot email: ${robotEmail} (as Editor).`);
            } else {
                logger.error(`[SHEETS] Writing error in writeResults: ${error.message}\nStack: ${error.stack}`);
            }
            return null;
        }
    }

    /**
     * Emergency fallback for when AI fails or is disabled.
     */
    runLocalModelingFallback(ideaName, price) {
        return {
            ideaName,
            analysis: {
                targetPrice: price || 29.99,
                estimatedUnitsPerDay: 25,
                seasonality: "365",
                baseballCategory: "Single",
                intelligenceBrief: "Local auto-discovery used (AI pending).",
                formatResearch: "Standard"
            },
            financials: this.runFinancialModeling(price || 29.99, "365", 25)
        };
    }
}

module.exports = new SheetsService();
