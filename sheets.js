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
            } 
            // Priority 2: Individual keys in env (The Vercel way)
            else if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
                credentials = {
                    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                };
            }
            // Priority 3: Local JSON fallback
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
                        throw new Error('Google Credentials not found (missing env vars and file)');
                    }
                }
            }

            const cleanNA = (val, fallback = '') => {
                if (val === 'N/A' || val === '-' || val === null || val === undefined) return fallback;
                return val;
            };

            this.auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            const authClient = await this.auth.getClient();
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
            const saEmail = credentials.client_email || 'Service Account';
            logger.info(`[SHEETS] Google Sheets API initialized using ${saEmail} for Sheet: ${spreadsheetId}`);
        } catch (error) {
            logger.error(`[SHEETS] Initialization error: ${error.message}`);
            throw error;
        }
    }

    getServiceAccountEmail() {
        if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        try {
            if (process.env.GOOGLE_CREDENTIALS) {
                const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS.trim().replace(/^-/, ''));
                return creds.client_email;
            }
        } catch (e) {}
        return 'the configured service account';
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
            
            // Helper for cleaning N/A and hyphens
            const fNA = (val, fallback = '') => (val === 'N/A' || val === '-' || !val) ? fallback : val;

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
                'Est. Units/day', 
                'Monthly Sales Badge',
                'Dimensions L×W×H',
                'Item Weight',
                'Item Volume / Count',
                'Positioning / Tier', 
                'Title (Hover/Click)',
                'Link'
            ];
            
            const grid = labels.map(l => [l]);
            
            const validDims = results.map(r => r.data?.dimensions).filter(d => d && d !== 'N/A' && d !== '-' && d !== '—');
            const dynamicDim = validDims.length > 0 ? validDims[0] : '8 x 5 x 2 inches';
            
            const validWeights = results.map(r => r.data?.weight).filter(w => w && w !== 'N/A' && w !== '-' && w !== '—');
            const dynamicWeight = validWeights.length > 0 ? validWeights[0] : '1.5 lbs';

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


                grid[0].push(i === 0 ? 'COLUMN 1 — INPUT PRODUCT' : `COLUMN ${i + 1} — COMPETITOR`);
                grid[1].push(d.imageUrl ? `=IMAGE("${d.imageUrl}")` : '—');
                grid[2].push(fNA(d.brand, 'Generic'));
                grid[3].push(fNA(d.asin));
                grid[4].push(fNA(d.price, '$29.99'));
                grid[5].push((d.stars && d.stars !== 'N/A') ? `★${d.stars}` : '★0.0');
                grid[6].push(fNA(d.reviews, '0'));
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
                
                if (estSales === '-' && d.bsr && d.bsr !== 'N/A') {
                    const bsrNum = parseInt(String(d.bsr).replace(/[^0-9]/g, ''));
                    if (!isNaN(bsrNum)) {
                        const { estimateDailySales } = require('./bsr');
                        const sales = estimateDailySales(bsrNum);
                        if (sales !== 'N/A') estSales = `Est. ${sales} / day`;
                    }
                }

                // If estSales still doesn't have a value, use AI vetting estimation or mark as Pending
                if (estSales === '-' || estSales === '—') {
                    if (ai && ai.estimatedUnitsPerDay) {
                         estSales = `Est. ${Math.floor(ai.estimatedUnitsPerDay)} / day`;
                    } else {
                         estSales = `Check Amazon / BSR`; // REPLACED: No more guessing '30'
                    }
                } else if (estSales.startsWith('~')) {
                    estSales = estSales.replace('~', 'Est. ');
                }

                // --- 100% ACCURACY MODE: UNIQUE DATA PER ASIN ---
                // No more neighbor/global fallbacks. 
                // Each column must report its own verified data or 'Pending' status.
                
                let finalDim = (!d.dimensions || d.dimensions === 'N/A' || d.dimensions === '-' || !d.dimensions.includes(' x ')) 
                               ? 'Dimensions Pending' 
                               : d.dimensions;
                
                let finalWeight = (!d.weight || d.weight === 'N/A' || d.weight === '-')
                                 ? 'Weight Pending'
                                 : d.weight;
                
                let finalVolume = (!d.volume || d.volume === 'N/A' || d.volume === '-')
                                  ? 'Volume Pending'
                                  : d.volume;

                grid[7].push(estSales);
                grid[8].push(fNA(d.boughtPastMonth, '< 50 bought in past month')); 
                grid[9].push(finalDim);
                grid[10].push(finalWeight);
                grid[11].push(finalVolume);
                grid[12].push(fNA(tier, 'Mid-Range'));
                grid[13].push(d.title ? d.title : 'Amazon Product');
                grid[14].push(d.url || `https://www.amazon.com/dp/${d.asin}`);
            }
            
            values.push(...grid);
            values.push([]); // Space
            values.push([]); // Space

            // SECTION 2 — Intelligence Brief (Condensed)
            const briefStartRow = values.length + 1;
            if (ai) {
                values.push(['SECTION 3 — Market Intelligence Brief', '', '', '', '', '', '', '']); 
                values.push(['STRATEGIC MARKET ANALYSIS', '', '', '', 'OPERATIONAL BENCHMARKS', '', '', '']);
                values.push([fNA(ai.intelligenceBrief, 'Comprehensive market analysis in progress...'), '', '', '', `Target SKU Size: ${fNA(ai.targetSize, '1-Unit Standard')}\nTarget Price Focus: $${fNA(ai.targetPrice, '0.00')}\nEst. Seasonality: ${fNA(ai.seasonality, '365')} days\nProduct Format: ${fNA(ai.formatResearch, 'Market Standard')}`, '', '', '']);
                values.push([]);
            }

            // SECTION 3 - PRICE LADDER (Unit Economics — Table 1)
            const priceLadderStartRow = values.length + 1; 
            values.push(['SECTION 3 — UNIT ECONOMICS & PRICE LADDER (Table 1)', '', '', '', '', '', '', '']); 
            
            // Header for Table 1 (Row 1 of section)
            let summaryCogsCell = 'A1'; // Fallback
            let summaryPriceCell = 'C1';
            let summaryMarginCell = 'B1';
            let summaryRevenueCell = 'D1';
            let summaryTargetPriceRow = 55; // Default fallback
            values.push([
                `${ideaName} COGS`, 
                'Ship By Amazon to Customer', 
                'Supplier to Amazon Warehouse', 
                'Referral Fee', 
                'Storage Fee + Inbounding cost', 
                'Selling Price', 
                'Net Profit', 
                'Gross Margin',
                'Select Target',
                'Estimated Units Sold / Day'
            ]); 
            
            let ladderStart = values.length + 1;
            let ladderEnd = ladderStart;
            
            if (financials) {
                const cogs = financials.targetCogs || 5.00;
                const fba = financials.fbaFee || 4.50;
                const supplierToAmazon = financials.supplierToAmazon || 1.25;
                const storageAndInbound = financials.storageAndInbound || 1.50;

                // Create a price ladder starting near the 30% gross margin point
                const thirtyPercentMarginPrice = (cogs + fba + supplierToAmazon + storageAndInbound) / 0.55;
                let basePrice = Math.max(9.99, Math.floor(thirtyPercentMarginPrice) - 3);

                summaryTargetPriceRow = priceLadderStartRow + 33;
                summaryCogsCell = `A${summaryTargetPriceRow}`;
                summaryMarginCell = `B${summaryTargetPriceRow}`; // New cell for Desired Margin (30%)
                summaryPriceCell = `C${summaryTargetPriceRow}`; // Price moves to C55
                summaryRevenueCell = `D${summaryTargetPriceRow}`; // Revenue moves to D55

                const targetPriceActual = financials.annualMetrics?.regularPrice || ai?.targetPrice || 29.99;
                const targetUnits = ai?.estimatedUnitsPerDay || 25;
                let closestIdx = 0;
                let minDiff = 9999;
                for (let i = 0; i < 26; i++) {
                    const diff = Math.abs((basePrice + i) - targetPriceActual);
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
                        `=$A$${summaryTargetPriceRow}`, // Make COGS dynamic based on A55
                        fba, 
                        supplierToAmazon, 
                        `=F${rowNum}*0.15`, 
                        storageAndInbound, 
                        currentPrice, // Just the value, not a pointer to C55
                        `=F${rowNum}-A${rowNum}-B${rowNum}-C${rowNum}-D${rowNum}-E${rowNum}`, 
                        `=IF(F${rowNum}>0, G${rowNum}/F${rowNum}, 0)`,
                        dropdownValue,
                        `=ROUND(${targetUnits} * POWER(${targetPriceActual} / F${rowNum}, 1.5), 0)`
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
                'Average inventory (Pack) holding every month', 'Product Name', 'Active Selling Price (Lookup)', 'Revenue', 'Return rate', 'Gross Margin', 
                'Ad Spend', 'Average Inventory value', 'Baseball Category', 'Lead Time (in days)', 'ROIC', 
                'Net Margin after ads', 'Expected Annual Contribution Margin ($)'
            ];

            const t3DataStartPredict = table2StartRow + 10;
            const t3DataEndPredict = t3DataStartPredict + 100; // Safe upper bound for formula summation

            const t2DataRow = table2StartRow + 2;

            // DYNAMIC LOOKUP: Instead of hardcoded $A$57, we search for the "Inventory Factor" label.
            // This makes the sheet "Dynamic" - the formula keeps working even if rows are inserted or moved.
            const inventoryLookup = `IFERROR(INDEX($A$1:$A$500, MATCH("Inventory Factor*", $B$1:$B$500, 0)), 0.5)`;
            
            const table2Data = [
                `=SUMIF($H$${t3DataStartPredict}:$H$${t3DataEndPredict}, "Most Likely Scenario", $A$${t3DataStartPredict}:$A$${t3DataEndPredict}) * ${ai?.sellingDaysPerYear || 365} * ${inventoryLookup}`, 
                ideaName, 
                `=${summaryPriceCell}`, // New Column: Explicitly show which price is driving ROIC
                `=SUMIF($H$${t3DataStartPredict}:$H$${t3DataEndPredict}, "Most Likely Scenario", $F$${t3DataStartPredict}:$F$${t3DataEndPredict})`, 
                m.retRate, 
                `=${summaryMarginCell}`, 
                `=D${t2DataRow} * 0.20`, // Adjusted index: Revenue is now D
                `=A${t2DataRow} * ${summaryCogsCell}`, 
                `=IF(D${t2DataRow}>=2500000, "Homerun", IF(D${t2DataRow}>=1500000, "Triple", IF(D${t2DataRow}>=750000, "Double", IF(D${t2DataRow}>=250000, "Single", "Less Than a Single"))))`, 
                m.leadTimeDays || 60, 
                `=IF(H${t2DataRow}>0, ((D${t2DataRow}*(1-E${t2DataRow})*F${t2DataRow}) - G${t2DataRow})/H${t2DataRow}*100, 0)`, // ROIC Adjusted
                `=IF(D${t2DataRow}>0, ((D${t2DataRow}*(1-E${t2DataRow})*F${t2DataRow}) - G${t2DataRow})/D${t2DataRow}, 0)`, // Margin Adjusted
                `=D${t2DataRow} * L${t2DataRow}` // Contribution Adjusted
            ];
            
            values.push(table2Headers);
            values.push(table2Data);

            // Summary Callouts (Row 55)
            // A55: COGS | B55: Margin | C55: Price | D55: Revenue
            const tFees = (financials?.fbaFee || 4.50) + (financials?.supplierToAmazon || 2.00) + (financials?.storageAndInbound || 1.50);
            values.push([
                financials?.targetCogs || 5.00, 
                `=(C${summaryTargetPriceRow}*0.85-A${summaryTargetPriceRow}-${tFees.toFixed(2)})/C${summaryTargetPriceRow}`, 
                `=IFERROR(INDEX($F$${ladderStart}:$F$${ladderEnd}, MATCH("Regular Price", $I$${ladderStart}:$I$${ladderEnd}, 0)), ${financials?.annualMetrics?.regularPrice || 29.99})`, 
                `=D${t2DataRow}`, 
                '<- Total Annual Revenue (Dynamic Selection Active)', '', '', '', '', '', '', '', ''
            ]);
            
            // Labels (Row 56)
            values.push([
                `^ Target COGS`, 
                `^ Desired Margin`, 
                `^ Active PRICE (VLOOKUP)`, 
                `^ Revenue Callout`, 
                '', '', '', '', '', '', '', '', ''
            ]);

            // Editable Inventory Factor (Row 57)
            values.push([
                0.5, 
                'Inventory Factor (Editable factor used for Avg Inventory)',
                '', '', '', '', '', '', '', '', '', '', ''
            ]);
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
                    `=IF(COUNTIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price")>0, ${summaryPriceCell}, ${s.sellingPrice || regularPrice})`,
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
                        `=IF(COUNTIF($I$${ladderStart}:$I$${ladderEnd}, "Regular Price")>0, ${summaryPriceCell}, ${fallbackPrice})`, 
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

            // === TABLE 1 FORMATTING ===
            const plStart = priceLadderStartRow; // 0-indexed header
            
            // Section Header
            mergeCells(plStart - 1, plStart, 0, 10);
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart - 1, endRowIndex: plStart, startColumnIndex: 0, endColumnIndex: 10 }, cell: { userEnteredFormat: { backgroundColor: headerNavy, textFormat: { bold: true, foregroundColor: headerTextWhite, fontSize: 12 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });

            // Table Header Colors (Labels row)
            [0, 1, 2, 5].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart, endRowIndex: plStart + 1, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { backgroundColor: yellowHeader, textFormat: { bold: true }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
            });
            [3, 4, 6, 7, 8, 9].forEach(c => {
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

            // Format column Column J (Index 9) for Units Elasticity
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 9, endColumnIndex: 10 }, cell: { userEnteredFormat: { backgroundColor: beigeCell, horizontalAlignment: 'CENTER', numberFormat: { type: 'NUMBER', pattern: '#,##0' }, textFormat: { italic: true } } }, fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,numberFormat,textFormat)' } });

            requests.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 7, endColumnIndex: 8 }], booleanRule: { condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '0.3' }] }, format: { backgroundColor: positiveMargin, textFormat: { bold: true } } } } } });
            requests.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: plStart + 1, endRowIndex: plStart + 27, startColumnIndex: 6, endColumnIndex: 7 }], booleanRule: { condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '0' }] }, format: { backgroundColor: negativeColor, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 } } } } } } });

            // === TABLE 2 FORMATTING (A{table2StartRow} onwards) ===
            const t2Start = table2StartRow; // 0-indexed header
            const lightBlueHeader = { red: 0.85, green: 0.91, blue: 0.99 }; // #DAE8FC
            
            // Section Header
            mergeCells(t2Start - 1, t2Start, 0, 12);
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start - 1, endRowIndex: t2Start, startColumnIndex: 0, endColumnIndex: 13 }, cell: { userEnteredFormat: { backgroundColor: headerNavy, textFormat: { bold: true, foregroundColor: headerTextWhite, fontSize: 13 }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });

            // Table 2 Header Style
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start, endRowIndex: t2Start + 1, startColumnIndex: 0, endColumnIndex: 13 }, cell: { userEnteredFormat: { backgroundColor: lightBlueHeader, textFormat: { bold: true }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)' } });
            
            // Format Table 2 Data (Row 2 of section)
            // Currency columns: C(Price), D(Rev), G(Ad), H(InvVal), M(CM) -> 2, 3, 6, 7, 12
            [2, 3, 6, 7, 12].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 3, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' } } }, fields: 'userEnteredFormat(numberFormat)' } });
            });

            // Special format for Active Price (Row 2, index 2) - highlight to show it's driving logic
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: 2, endColumnIndex: 3 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.95, green: 0.95, blue: 0.1 }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Percent columns: E(Ret), F(GM), L(Net Margin) -> 4, 5, 11
            [4, 5, 11].forEach(c => {
                requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.00%' } } }, fields: 'userEnteredFormat(numberFormat)' } });
            });

            // HIGHLIGHT RULES TABLE 2
            // ROIC (Index 10 / Col K) Highlight - Row 2
            requests.push({
                addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: 10, endColumnIndex: 11 }], booleanRule: { condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '200' }] }, format: { backgroundColor: positiveMargin, textFormat: { bold: true } } } } }
            });

            // Gross Margin (Index 5 / Col F) Highlight - Row 2
            requests.push({
                addConditionalFormatRule: { rule: { ranges: [{ sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 2, startColumnIndex: 5, endColumnIndex: 6 }], booleanRule: { condition: { type: 'NUMBER_GREATER_THAN_EQ', values: [{ userEnteredValue: '0.3' }] }, format: { backgroundColor: greenCell, textFormat: { bold: true } } } } }
            });

            // Row 3 Summary Cells (Index 2 of t2)
            // A (Cogs) - Yellow
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 2, endRowIndex: t2Start + 3, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: yellowHeader, numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat)' } });
            // B (Margin) - Green
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 2, endRowIndex: t2Start + 3, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { backgroundColor: greenCell, numberFormat: { type: 'PERCENT', pattern: '0.00%' }, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,numberFormat,textFormat)' } });
            // Label Row for below A/B
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 3, endRowIndex: t2Start + 4, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 1.0, blue: 0.9 }, textFormat: { italic: true, fontSize: 8 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Inventory Factor Formatting (Row 57 / index t2Start + 4)
            // A57 (Factor) - Orange to show it's editable
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 4, endRowIndex: t2Start + 5, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.6, blue: 0.2 }, textFormat: { bold: true }, horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } });
            // B57 (Label) - Light Green
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 4, endRowIndex: t2Start + 5, startColumnIndex: 1, endColumnIndex: 4 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 1.0, blue: 0.9 }, textFormat: { italic: true, fontSize: 8 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Contribution Margin (Col M / Index 12) in Orange
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 1, endRowIndex: t2Start + 3, startColumnIndex: 12, endColumnIndex: 13 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.6, blue: 0 }, textFormat: { bold: true, fontSize: 12 } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });

            // Total Annual Revenue callout (Col D / Index 3 Row 3) in Orange
            requests.push({ repeatCell: { range: { sheetId, startRowIndex: t2Start + 2, endRowIndex: t2Start + 3, startColumnIndex: 3, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.6, blue: 0 }, textFormat: { bold: true }, numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0' } } }, fields: 'userEnteredFormat(backgroundColor,textFormat,numberFormat)' } });

            // Column Widths for Table 2 (A:M)
            const table2ColWidths = [180, 180, 150, 150, 100, 100, 120, 150, 120, 100, 120, 120, 200];
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

            // --- TABLE 3 DYNAMIC SELECTORS & HIGHLIGHTS ---
            // 1. Dropdown Selector in Col H (Scenario Label)
            requests.push({ 
                setDataValidation: { 
                    range: { sheetId, startRowIndex: t3DataStart, endRowIndex: t3DataEnd, startColumnIndex: 7, endColumnIndex: 8 }, 
                    rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Most Likely Scenario' }, { userEnteredValue: 'Best Case Scenario' }] }, showCustomUi: true, strict: false } 
                } 
            });

            // 2. Dynamic Highlighting (Yellow for Most Likely)
            requests.push({
                addConditionalFormatRule: {
                    rule: {
                        ranges: [{ sheetId, startRowIndex: t3DataStart, endRowIndex: t3DataEnd, startColumnIndex: 0, endColumnIndex: 8 }],
                        booleanRule: {
                            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Most Likely Scenario' }] },
                            format: { backgroundColor: yellowHighlight, textFormat: { bold: true } }
                        }
                    }, index: 0
                }
            });

            // 3. Dynamic Highlighting (Green for Best Case)
            requests.push({
                addConditionalFormatRule: {
                    rule: {
                        ranges: [{ sheetId, startRowIndex: t3DataStart, endRowIndex: t3DataEnd, startColumnIndex: 0, endColumnIndex: 8 }],
                        booleanRule: {
                            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Best Case Scenario' }] },
                            format: { backgroundColor: greenHighlight, textFormat: { bold: true, foregroundColor: darkGreenText } }
                        }
                    }, index: 0
                }
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
     * Emergency fallback for when AI fails or is disabled (Legacy/Internal)
     */
    runLocalModelingFallback(ideaName, price) {
        // Delegate to vetting engine for consistency
        const vettingEngine = require('./vettingEngine');
        const units = 25;
        const best = 41;
        const analysis = {
            targetPrice: price || 29.99,
            estimatedUnitsPerDay: units,
            seasonality: "365",
            baseballCategory: "Single",
            intelligenceBrief: "Local auto-discovery used (AI pending).",
            formatResearch: "Standard"
        };
        const financials = vettingEngine.runFinancialModeling(price || 29.99, "365", units, best, 0.025, ideaName);

        return {
            ideaName,
            analysis,
            financials
        };
    }
}

module.exports = new SheetsService();
