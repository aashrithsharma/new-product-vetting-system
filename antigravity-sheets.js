const { google } = require('googleapis');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

class AntigravitySheetsService {
    constructor() {
        this.auth = null;
        this.sheets = null;
    }

    async init(sheetId) {
        try {
            const spreadsheetId = sheetId || config.google.sheetId;
            if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID missing');
            let credentials;
            
            // Priority 1: Full JSON block in env
            if (process.env.GOOGLE_CREDENTIALS) {
                let cleanCreds = process.env.GOOGLE_CREDENTIALS.trim();
                if (cleanCreds.startsWith('-')) cleanCreds = cleanCreds.substring(1).trim();
                credentials = JSON.parse(cleanCreds);
            } 
            // Priority 2: Individual keys in env (The Vercel way)
            else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
                credentials = {
                    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                };
            }
            // Priority 3: Local JSON file
            else {
                let credString = config.google.credentialsPath || '';
                credString = credString.trim();
                if (credString.startsWith('-')) credString = credString.substring(1).trim();
                try {
                    credentials = JSON.parse(credString);
                } catch (e) {
                    if (fs.existsSync(credString)) {
                        credentials = JSON.parse(fs.readFileSync(credString, 'utf8'));
                    } else {
                        throw new Error('Google Credentials not found (env or file)');
                    }
                }
            }

            this.auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            const authClient = await this.auth.getClient();
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
            logger.info(`[ANTIGRAVITY-SHEETS] Initialized for: ${spreadsheetId}`);
        } catch (error) {
            logger.error(`[ANTIGRAVITY-SHEETS] Initialization error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Exact implementation of the Antigravity Price Calculator Template
     */
    async writeCalculator(results, sheetId, vettingResults, ideaName) {
        if (!results || results.length === 0) {
            logger.warn('[ANTIGRAVITY-SHEETS] No results to write');
            return null;
        }

        const spreadsheetId = sheetId || config.google.sheetId;
        const analysis = vettingResults.analysis;
        const ctx = vettingResults.context;

        try {
            await this.init(spreadsheetId);
            const spreadsheetRes = await this.sheets.spreadsheets.get({ spreadsheetId });
            const sheetsList = spreadsheetRes.data.sheets || [];

            let targetSheetTitle = `AG_${ideaName.replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 25)}`;
            const existingSheet = sheetsList.find(s => s.properties.title === targetSheetTitle);
            let targetSheetId;
            
            if (existingSheet) {
                targetSheetId = existingSheet.properties.sheetId;
                await this.sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${targetSheetTitle}'!A1:ZZ` });
                try {
                    const reqs = [{ unmergeCells: { range: { sheetId: targetSheetId } } }];
                    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests: reqs } });
                } catch(e) {}
            } else {
                targetSheetId = Math.floor(Math.random() * 10000000);
                await this.sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    resource: {
                        requests: [{ addSheet: { properties: { sheetId: targetSheetId, title: targetSheetTitle } } }]
                    }
                });
            }

            // === 1. BUILD DATA ROWS ===
            const values = Array(100).fill(0).map(() => Array(30).fill(''));

            // COMP RESEARCH SECTION (Rows 1-10)
            // (Note: In JS indices are 0-based, so Row 1 is values[0])
            values[0][1] = 'Size'; // B1
            values[1][1] = 'Form'; // B2 (Image)
            values[2][1] = 'Brand Name'; // B3
            values[3][1] = 'ASIN'; // B4
            values[4][1] = 'Selling Price'; // B5
            values[5][1] = 'Stars'; // B6
            values[6][1] = 'Reviews'; // B7
            values[7][1] = 'Average units sold per day'; // B8
            values[8][1] = 'Dimensions'; // B9
            values[9][1] = 'Weight'; // B10
            values[10][1] = 'Title'; // B11

            for (let i = 0; i < Math.min(results.length, 6); i++) {
                const colIdx = i + 2; // C onwards
                const d = results[i].data;
                const aiComp = analysis.competitorAnalysis ? analysis.competitorAnalysis.find(c => c.asin === d.asin) : null;
                
                values[0][colIdx] = d.size || 'N/A';
                values[1][colIdx] = `=IMAGE("${d.imageUrl || ''}")`;
                values[2][colIdx] = d.brand || 'N/A';
                values[3][colIdx] = d.asin || 'N/A';
                values[4][colIdx] = d.price || 'N/A';
                values[5][colIdx] = d.stars || 'N/A';
                values[6][colIdx] = d.reviews || 'N/A';
                values[7][colIdx] = aiComp ? aiComp.estimatedUnitsPerDay : (d.boughtPastMonth || 'N/A');
                values[8][colIdx] = d.dimensions || 'N/A';
                values[9][colIdx] = d.weight || 'N/A';
                values[10][colIdx] = d.title || 'N/A';
            }

            // I5 - Target COGS for SKU 1
            values[4][8] = analysis.sku1.targetCogs;
            values[4][9] = '<-- Note: You can play around with the COGS here and see all other numbers (ROIC, EACM etc.) changing';
            
            // I7 - Target COGS for SKU 2
            if (analysis.sku2 && analysis.sku2.name) {
                values[6][8] = analysis.sku2.targetCogs;
            }

            // SUMMARY HEADERS (Rows 2-5, Col I-T) - Note: 0-indexed I is 8
            const summaryHeaders = [
                'Average inventory (Pack) holding every month', 'Product Name', 'Revenue', 'Return rate', 'Gross Margin',
                'Ad Spend', 'Average Inventory value', 'Baseball Category', 'Lead Time (in days)', 'ROIC',
                'Net Margin after ads', 'Expected Annual Contribution Margin ($)'
            ];
            summaryHeaders.forEach((h, idx) => { values[1][8 + idx] = h; });

            // --- EDITABLE INVENTORY FACTOR (Row 7, 0.5 cells below Table 2) ---
            // This 0.5 factor is used in: Avg Inventory = Units Sold/Day * 365 * factor
            // Users can change M7 to 0.4, 0.3, etc. and all inventory values update automatically.
            values[6][11] = 'Inventory Factor (editable ↓)'; // L7 - label
            values[6][12] = 0.5;                              // M7 - editable value (default 0.5)
            values[6][13] = '<-- Change this factor to adjust Avg Inventory. Formula: Units/Day (3rd table) × 365 × Factor'; // N7 - instruction

            // DYNAMIC LOOKUP: Instead of hardcoded cell references, we search for the "Inventory Factor" label.
            const invFactorFormula = `IFERROR(INDEX($M$1:$M$20, MATCH("Inventory Factor*", $L$1:$L$20, 0)), 0.5)`;

            // SKU 1 Summary Data (Row 3)
            const sku1 = analysis.sku1;
            // Dynamic Selling Price for SKU 1 from Ladder (used for calculation)
            const sku1ActivePriceFormula = `IFERROR(INDEX(F12:F37, MATCH("Regular Price", I12:I37, 0)), ${sku1.regularPrice || 29.99})`;

            values[2][8] = `=INDEX(J17:J42, MATCH("Most Likely Scenario", P17:P42, 0)) * ${ctx.sellingDaysPerYear || 365} * ${invFactorFormula}`; // I3 (Units/day * Days * Dynamic Factor)
            values[2][9] = sku1.name; // J3
            values[2][10] = `=INDEX(N17:N42, MATCH("Most Likely Scenario", P17:P42, 0))`; // K3
            values[2][11] = ctx.returnRate; // L3
            values[2][12] = `=(${sku1ActivePriceFormula}*0.85-I5-8)/${sku1ActivePriceFormula}`; // M3 (Gross Margin)
            values[2][13] = `=K3*${ctx.adSpendRate}`; // N3 (Ad Spend)
            values[2][14] = `=I3*I5`; // O3
            values[2][15] = sku1.baseballCategory; // P3
            values[2][16] = ctx.leadTimeDays; // Q3
            values[2][17] = `=(((K3*(1-L3)*M3)-N3)/O3)*100`; // R3 (ROIC)
            values[2][18] = `=(((K3*(1-L3)*M3)-N3)/K3)`; // S3 (Net Margin)
            values[2][19] = `=S3*K3`; // T3 (EACM)

            // Link B5 (Selling Price) to the dynamic selection for SKU 1
            values[4][2] = `=${sku1ActivePriceFormula}`; 

            // SKU 2 Summary Data (Row 4) - Optional
            if (analysis.sku2 && analysis.sku2.name) {
                const sku2 = analysis.sku2;
                const sku2ActivePriceFormula = `IFERROR(INDEX(F41:F66, MATCH("Regular Price", I41:I66, 0)), ${sku2.regularPrice || 39.99})`;
                
                values[3][8] = `=INDEX(J47:J72, MATCH("Most Likely Scenario", P47:P72, 0)) * ${ctx.sellingDaysPerYear || 365} * ${invFactorFormula}`; // I4 (Units/day * Days * Dynamic Factor)
                values[3][9] = sku2.name; // J4
                values[3][10] = `=INDEX(N47:N72, MATCH("Most Likely Scenario", P47:P72, 0))`; // K4
                values[3][11] = ctx.returnRate; // L4
                values[3][12] = `=(${sku2ActivePriceFormula}*0.85-I7-8)/${sku2ActivePriceFormula}`; // M4
                values[3][13] = `=K4*${ctx.adSpendRate}`; // N4
                values[3][14] = `=I4*I7`; // O4
                values[3][15] = sku2.baseballCategory; // P4
                values[3][16] = ctx.leadTimeDays; // Q4
                values[3][17] = `=(((K4*(1-L4)*M4)-N4)/O4)*100`; // R4
                values[3][18] = `=(((K4*(1-L4)*M4)-N4)/K4)`; // S4
                values[3][19] = `=S4*K4`; // T4
            }

            // Totals Row (Row 5 - Right side summary)
            values[4][10] = `=SUM(K3:K4)`; // K5 (Yellow Total Revenue)
            values[4][11] = `=AVERAGE(L3:L4)`; // L5
            values[4][12] = `=IFERROR(AVERAGE.WEIGHTED(M3:M4,K3:K4), M3)`; // M5 (Weighted Gross Margin)
            values[4][13] = `=SUM(N3:N4)`; // N5
            values[4][14] = `=SUM(O3:O4)`; // O5
            values[4][17] = `=(((K5*(1-L5)*M5)-N5)/O5)*100`; // R5
            values[4][18] = `=(((K5*(1-L5)*M5)-N5)/K5)`; // S5
            values[4][19] = `=SUM(T3:T4)`; // T5 (Green Total EACM)

            // COST TABLE SKUs HEADERS (Row 11)
            values[10][1] = `=J3&" COGS"`; // B11
            values[10][2] = `Ship By Amazon to Customer`; // C11
            values[10][3] = `Six10 Ventures Warehouse to Amazon Warehouse+ storage + inbounding costs`; // D11 (Modified to match user label)
            values[10][4] = `Referral Fee`; // E11
            values[10][5] = `Selling Price`; // F11
            values[10][6] = `Net Profit`; // G11
            values[10][7] = `Gross Margin`; // H11

            // COST TABLE (Rows 12-37)
            // Calculate basePrice to start near the 30% Gross Margin point
            const sku1TargetCogs = analysis.sku1.targetCogs || 5.50;
            const sku1Fba = analysis.sku1.fbaFee || 4.50;
            const sku1Warehouse = ctx.supplierToWarehouseShipping || 1.50;
            const thirtyPercentMarginPriceSku1 = (sku1TargetCogs + sku1Fba + sku1Warehouse) / 0.55;
            
            // Start the ladder a few rows below the 30% target 
            let basePrice = Math.max(9.99, Math.floor(thirtyPercentMarginPriceSku1) - 3);

            // COST TABLE (Rows 12-37)
            for (let i = 0; i < 26; i++) {
                const r = 11 + i;
                const sellPrice = basePrice + i;
                values[r][1] = `=$I$5`; // B (Absolute ref to COGS)
                values[r][2] = sku1.fbaFee; // C
                values[r][3] = ctx.supplierToWarehouseShipping; // D
                values[r][4] = `=0.15*F${r+1}`; // E
                values[r][5] = sellPrice; // F
                values[r][6] = `=F${r+1}-(B${r+1}+C${r+1}+D${r+1}+E${r+1})`; // G
                values[r][7] = `=G${r+1}/F${r+1}`; // H
                
                if (Math.abs(sellPrice - sku1.regularPrice) < 0.1) {
                    values[r][8] = 'Regular Price';
                }
            }

            // REVENUE SCENARIO TABLE (Right of Cost Table, Row 16+)
            values[15][9] = 'Expected units we can sell per day'; // J16
            values[15][10] = 'Selling Price'; // K16
            values[15][11] = 'Daily Revenue'; // L16
            values[15][12] = 'Number of days to sell in a year'; // M16
            values[15][13] = 'EXpected Annual Revenue'; // N16
            values[15][14] = 'Percentage of total Annual Revenue'; // O16

            let scRowOffset = 16;
            const unitsScenarios = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49, 51];
            unitsScenarios.forEach((u, i) => {
                const r = scRowOffset + i;
                values[r][9] = u; // J
                values[r][10] = `=INDEX($F$12:$F$37, MATCH("Regular Price", $I$12:$I$37, 0))`; // K (Pulls regular price from SKU 1 ladder)
                values[r][11] = `=J${r+1}*K${r+1}`; // L
                values[r][12] = ctx.sellingDaysPerYear; // M
                values[r][13] = `=L${r+1}*M${r+1}`; // N
                values[r][14] = `=N${r+1}/$M$12`; // O

                if (u === sku1.mostLikelyUnitsPerDay) values[r][15] = 'Most Likely Scenario';
                if (u === sku1.bestCaseUnitsPerDay) values[r][15] = 'Best Case Scenario';
            });

            values[11][12] = ctx.six10TrailingRevenue; // M12 (Total trailing revenue cell)
            
            // Link back to summary K3
            // This section is now replaced by the INDEX/MATCH formula for K3 directly.
            // const scenarioRow = unitsScenarios.indexOf(sku1.mostLikelyUnitsPerDay);
            // if (scenarioRow !== -1) {
            //     values[2][10] = `=N${scRowStart + scenarioRow + 1}`; // K3
            // } else {
            //     values[2][10] = `=N16`; // Fallback
            // }

            // === 2nd SKU Table (Row 40+) ===
            if (analysis.sku2 && analysis.sku2.name) {
                const sku2 = analysis.sku2;
                values[39][1] = `=J4&" COGS"`; // B40
                values[39][2] = `Ship By Amazon to Customer`; 
                values[39][3] = `Six10 Ventures Warehouse to Amazon Warehouse+ storage + inbounding costs`;
                values[39][4] = `Referral Fee`;
                values[39][5] = `Selling Price`;
                values[39][6] = `Net Profit`;
                values[39][7] = `Gross Margin`;

                const sku2TargetCogs = analysis.sku2.targetCogs || 15.00;
                const sku2Fba = analysis.sku2.fbaFee || 6.50;
                const zeroMarginPriceSku2 = (sku2TargetCogs + sku2Fba + ctx.supplierToWarehouseShipping) / 0.85;
                let sku2BasePrice = Math.max(9.99, Math.floor(zeroMarginPriceSku2 - 3));

                for (let i = 0; i < 26; i++) {
                    const r = 40 + i;
                    const sellPrice = sku2BasePrice + i; 
                    values[r][1] = `=$I$7`; // B uses SKU 2 COGS
                    values[r][2] = sku2.fbaFee; // C
                    values[r][3] = ctx.supplierToWarehouseShipping; // D
                    values[r][4] = `=0.15*F${r+1}`; // E
                    values[r][5] = sellPrice; // F
                    values[r][6] = `=F${r+1}-(B${r+1}+C${r+1}+D${r+1}+E${r+1})`; // G
                    values[r][7] = `=G${r+1}/F${r+1}`; // H
                    if (Math.abs(sellPrice - sku2.regularPrice) < 0.1) values[r][8] = 'Regular Price';
                }

                // SKU 2 REVENUE SCENARIO TABLE (Right of Cost Table, Row 46+)
                let sku2ScRowOffset = 46;
                unitsScenarios.forEach((u, i) => {
                    const r = sku2ScRowOffset + i;
                    values[r][9] = u; // J
                    values[r][10] = `=INDEX($F$41:$F$66, MATCH("Regular Price", $I$41:$I$66, 0))`; // K (Pulls regular price from SKU 2 ladder)
                    values[r][11] = `=J${r+1}*K${r+1}`; // L
                    values[r][12] = ctx.sellingDaysPerYear; // M
                    values[r][13] = `=L${r+1}*M${r+1}`; // N
                    values[r][14] = `=N${r+1}/$M$12`; // O

                    if (u === sku2.mostLikelyUnitsPerDay) values[r][15] = 'Most Likely Scenario';
                    if (u === sku2.bestCaseUnitsPerDay) values[r][15] = 'Best Case Scenario';
                });
            }

            // Write values
            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `'${targetSheetTitle}'!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values },
            });

            // === 2. APPLY RIGID FORMATTING & COLORS ===
            const requests = [];
            const addReq = (r) => requests.push(r);

            // Row 1 B: "Size" Bold
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat(textFormat)' } });
            
            // Cyan fills Row 1 (00FFFF)
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: { red: 0, green: 1, blue: 1 } } }, fields: 'userEnteredFormat(backgroundColor)' } });

            // Yellow fill Row 5 B (Selling Price)
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // --- Inventory Factor row (Row 7 = index 6) formatting ---
            // Label cell L7 (col 11): bold, light orange background
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 11, endColumnIndex: 12 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.9, blue: 0.6 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            // Value cell M7 (col 12): bright orange fill, bold - this is the editable 0.5 factor
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 12, endColumnIndex: 13 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.65, blue: 0 }, textFormat: { bold: true, fontSize: 12 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            // Instruction cell N7 (col 13): italic, grey text
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 13, endColumnIndex: 20 }, cell: { userEnteredFormat: { textFormat: { italic: true, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } } }, fields: 'userEnteredFormat(textFormat)' } });

            // Light blue (C9DAF8) Summary headers
            addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 8, endColumnIndex: 23 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.78, green: 0.85, blue: 0.97 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Cost Table Headers (Row 11) - Yellow (FFFF00)
            const yellowCols = [1, 2, 3, 5]; // B, C, D, F
            yellowCols.forEach(c => {
                addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 10, endRowIndex: 11, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            });
            // Grey (666666) Headers
            const greyCols = [4, 6, 7]; // E, G, H
            greyCols.forEach(c => {
                addReq({ repeatCell: { range: { sheetId: targetSheetId, startRowIndex: 10, endRowIndex: 11, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.4, green: 0.4, blue: 0.4 }, textFormat: { foregroundColor: { red: 1, green: 0.9, blue: 0.6 }, bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
            });

            // Conditional Formatting for Gross Margin (H12:H37)
            addReq({
                addConditionalFormatRule: {
                    rule: {
                        ranges: [{ sheetId: targetSheetId, startRowIndex: 11, endRowIndex: 37, startColumnIndex: 7, endColumnIndex: 8 }],
                        booleanRule: {
                            condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '0.3' }] },
                            format: { backgroundColor: { red: 0.7, green: 0.9, blue: 0.7 } }
                        }
                    }, index: 0
                }
            });
            addReq({
                addConditionalFormatRule: {
                    rule: {
                        ranges: [{ sheetId: targetSheetId, startRowIndex: 11, endRowIndex: 37, startColumnIndex: 7, endColumnIndex: 8 }],
                        booleanRule: {
                            condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '0.3' }] },
                            format: { backgroundColor: { red: 0.9, green: 0.7, blue: 0.7 } }
                        }
                    }, index: 1
                }
            });

            // --- SKU 1 VOLUME SCENARIOS (Table 3) SELECTORS & HIGHLIGHTS ---
            // 1. Dropdowns in Col P (index 15) for Row 17-42
            addReq({ setDataValidation: { range: { sheetId: targetSheetId, startRowIndex: 16, endRowIndex: 42, startColumnIndex: 15, endColumnIndex: 16 }, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Most Likely Scenario' }, { userEnteredValue: 'Best Case Scenario' }] }, showCustomUi: true, strict: false } } });
            // 2. Dynamic Highlight (Yellow - Most Likely)
            addReq({ addConditionalFormatRule: { rule: { ranges: [{ sheetId: targetSheetId, startRowIndex: 16, endRowIndex: 42, startColumnIndex: 9, endColumnIndex: 16 }], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Most Likely Scenario' }] }, format: { backgroundColor: { red: 1, green: 1, blue: 0 }, textFormat: { bold: true } } } }, index: 2 } });
            // 3. Dynamic Highlight (Green - Best Case)
            addReq({ addConditionalFormatRule: { rule: { ranges: [{ sheetId: targetSheetId, startRowIndex: 16, endRowIndex: 42, startColumnIndex: 9, endColumnIndex: 16 }], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Best Case Scenario' }] }, format: { backgroundColor: { red: 0, green: 0.85, blue: 0 }, textFormat: { bold: true } } } }, index: 3 } });

            // --- SKU 2 VOLUME SCENARIOS (Table 3) SELECTORS & HIGHLIGHTS ---
            if (analysis.sku2 && analysis.sku2.name) {
                // 1. Dropdowns in Col P (index 15) for Row 47-72
                addReq({ setDataValidation: { range: { sheetId: targetSheetId, startRowIndex: 46, endRowIndex: 72, startColumnIndex: 15, endColumnIndex: 16 }, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Most Likely Scenario' }, { userEnteredValue: 'Best Case Scenario' }] }, showCustomUi: true, strict: false } } });
                // 2. Dynamic Highlight (Yellow - Most Likely)
                addReq({ addConditionalFormatRule: { rule: { ranges: [{ sheetId: targetSheetId, startRowIndex: 46, endRowIndex: 72, startColumnIndex: 9, endColumnIndex: 16 }], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Most Likely Scenario' }] }, format: { backgroundColor: { red: 1, green: 1, blue: 0 }, textFormat: { bold: true } } } }, index: 4 } });
                // 3. Dynamic Highlight (Green - Best Case)
                addReq({ addConditionalFormatRule: { rule: { ranges: [{ sheetId: targetSheetId, startRowIndex: 46, endRowIndex: 72, startColumnIndex: 9, endColumnIndex: 16 }], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Best Case Scenario' }] }, format: { backgroundColor: { red: 0, green: 0.85, blue: 0 }, textFormat: { bold: true } } } }, index: 5 } });
            }

            // Set column widths
            const colWidths = [50, 200, 100, 100, 100, 100, 100, 100, 200, 150];
            colWidths.forEach((w, i) => {
                addReq({ updateDimensionProperties: { range: { sheetId: targetSheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize' } });
            });

            await this.sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });

            return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${targetSheetId}`;
        } catch (error) {
            logger.error(`[ANTIGRAVITY-SHEETS] Writing error: ${error.message}`);
            return null;
        }
    }
}

module.exports = new AntigravitySheetsService();
