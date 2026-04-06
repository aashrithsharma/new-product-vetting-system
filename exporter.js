const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

class ExcelExporter {
    async generateOutputs(results, outputDir, vettingResults = {}, ideaName = 'Scrape Results') {
        const timestamp = Date.now();
        const safeIdeaName = ideaName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const xlsxPath = path.join(outputDir, `analysis_${safeIdeaName}_${timestamp}.xlsx`);

        try {
            await this.generateXlsx(results, xlsxPath, vettingResults, ideaName);
            return { xlsx: xlsxPath };
        } catch (error) {
            logger.error(`[EXPORTER] Error generating outputs: ${error.message}`);
            return {};
        }
    }

    async generateXlsx(results, xlsxPath, vettingResults, ideaName) {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Antigravity Analysis');

        const ai = vettingResults && vettingResults.analysis ? vettingResults.analysis : null;
        const financials = vettingResults && vettingResults.financials ? vettingResults.financials : null;
        const ctx = vettingResults && vettingResults.context ? vettingResults.context : { 
            avgInventoryHolding: 1000, 
            returnRate: 0.05, 
            adSpendRate: 0.15,
            leadTimeDays: 45,
            supplierToWarehouseShipping: 1.50,
            sellingDaysPerYear: 365,
            six10TrailingRevenue: 25000000 
        };

        const targetP = ai?.targetPrice || financials?.targetPrice || 29.99;

        // --- RIGID COLORS & STYLES (Matching Sheets exactly) ---
        const cyanFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FFFF' } };
        const yellowFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        const lightBlueFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC9DAF8' } };
        const darkGreyFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF666666' } };
        const beigeText = { color: { argb: 'FFFFF2CC' }, bold: true };
        const boldFont = { bold: true };
        const centerAlignment = { horizontal: 'center', vertical: 'middle' };
        
        // --- 1. SIDE-BY-SIDE COMPETITOR COMPARISON (Rows 1-9) ---
        const compHeaders = ['Size', 'Form', 'Brand Name', 'ASIN', 'Selling Price', 'Average units sold per day', 'Stars', 'Reviews', 'Title'];
        compHeaders.forEach((h, i) => {
            const cell = sheet.getCell(i + 1, 2); // B1-B9
            cell.value = h;
            cell.font = boldFont;
        });

        const maxComps = Math.min(results.length, 6);
        for (let i = 0; i < maxComps; i++) {
            const d = results[i].data;
            const colIdx = i + 3; // C-H
            const aiComp = ai?.competitorAnalysis ? ai.competitorAnalysis.find(c => c.asin === d.asin) : null;

            sheet.getCell(1, colIdx).value = d.size || 'N/A';
            sheet.getCell(1, colIdx).fill = cyanFill; 
            
            sheet.getCell(2, colIdx).value = 'IMAGE'; 
            sheet.getCell(3, colIdx).value = d.brand || 'N/A';
            sheet.getCell(4, colIdx).value = d.asin || 'N/A';
            
            const price = parseFloat(String(d.price || '0').replace(/[^0-9.]/g, '')) || 0;
            sheet.getCell(5, colIdx).value = price;
            sheet.getCell(5, colIdx).fill = yellowFill; 
            sheet.getCell(5, colIdx).font = boldFont;
            sheet.getCell(5, colIdx).numFmt = '"$"#,##0.00';

            sheet.getCell(6, colIdx).value = aiComp ? aiComp.estimatedUnitsPerDay : (parseInt(String(d.boughtPastMonth || '0').replace(/[^0-9]/g, '')) || 0);
            sheet.getCell(7, colIdx).value = parseFloat(d.stars) || 0;
            sheet.getCell(8, colIdx).value = parseInt(String(d.reviews || '0').replace(/[^0-9]/g, '')) || 0;
            sheet.getCell(9, colIdx).value = d.title || 'N/A';
        }

        // --- 2. SUMMARY DASHBOARD ---
        const summaryHeaders = [
            'Average inventory (Pack) holding every month', 'Product Name', 'Revenue', 'Return rate', 'Gross Margin',
            'Ad Spend', 'Average Inventory value', 'Baseball Category', 'Lead Time (in days)', 'ROIC',
            'Net Margin after ads', 'Expected Annual Contribution Margin ($)'
        ];
        summaryHeaders.forEach((h, idx) => {
            const cell = sheet.getCell(2, 9 + idx);
            cell.value = h;
            cell.font = boldFont;
            cell.fill = lightBlueFill;
            cell.alignment = { wrapText: true, ...centerAlignment };
        });

        const sku1 = ai?.sku1 || { name: ideaName, baseballCategory: 'Elite' };
        sheet.getCell(3, 9).value = ctx.avgInventoryHolding;
        sheet.getCell(3, 10).value = sku1.name;
        sheet.getCell(3, 12).value = ctx.returnRate;
        sheet.getCell(3, 12).numFmt = '0.0%';
        sheet.getCell(3, 16).value = sku1.baseballCategory;
        sheet.getCell(3, 17).value = ctx.leadTimeDays;

        const ladderStartRow = 12;
        const ladderRowsCount = 15;
        const ladderEndRow = ladderStartRow + ladderRowsCount - 1;
        const scenarioStartRow = 17;
        const scenarioRowsCount = 15;
        const scenarioEndRow = scenarioStartRow + scenarioRowsCount - 1;

        sheet.getCell(3, 11).value = { formula: `INDEX(N${scenarioStartRow}:N${scenarioEndRow}, MATCH("Most Likely Scenario", P${scenarioStartRow}:P${scenarioEndRow}, 0))` }; 
        sheet.getCell(3, 13).value = { formula: `INDEX(H${ladderStartRow}:H${ladderEndRow}, MATCH("Regular Price", I${ladderStartRow}:I${ladderEndRow}, 0))` }; 
        sheet.getCell(3, 14).value = { formula: `K3*${ctx.adSpendRate}` }; 
        sheet.getCell(3, 15).value = { formula: `I3*I5` }; 
        sheet.getCell(3, 18).value = { formula: `(((K3*(1-L3)*M3)-N3)/O3)*100` }; 
        sheet.getCell(3, 19).value = { formula: `(((K3*(1-L3)*M3)-N3)/K3)` }; 
        sheet.getCell(3, 20).value = { formula: `S3*K3` }; 

        sheet.getCell(5, 9).value = financials?.targetCogs || 5.50;
        sheet.getCell(5, 9).numFmt = '"$"#,##0.00';
        sheet.getCell(5, 10).value = '<-- Total Target COGS SKU 1 (Edit here)';

        // --- 3. UNIT ECONOMICS TABLE ---
        const costHeaders = [
            `=$J$3&" COGS"`, 'Ship Amazon to Customer', 'Warehouse to Amazon+storage', 'Referral Fee', 'Selling Price', 'Net Profit', 'Gross Margin'
        ];
        costHeaders.forEach((h, i) => {
            const cell = sheet.getCell(11, 2 + i);
            cell.value = (i === 0) ? { formula: h } : h;
            cell.font = boldFont;
            if (i === 0 || i === 1 || i === 2 || i === 4) {
                cell.fill = yellowFill;
            } else {
                cell.fill = darkGreyFill;
                cell.font = beigeText;
            }
            cell.alignment = centerAlignment;
        });

        const fFba = financials?.fbaFee || 4.50;
        const fWarehouseToAmazon = ctx.supplierToWarehouseShipping || 1.50;
        let pBase = Math.max(5, Math.floor(targetP - 7));

        for (let i = 0; i < ladderRowsCount; i++) {
            const r = ladderStartRow + i;
            const p = pBase + i;
            sheet.getCell(r, 2).value = { formula: '$I$5' };
            sheet.getCell(r, 3).value = fFba;
            sheet.getCell(r, 4).value = fWarehouseToAmazon;
            sheet.getCell(r, 5).value = { formula: `F${r}*0.15` };
            sheet.getCell(r, 6).value = p;
            sheet.getCell(r, 7).value = { formula: `F${r}-(B${r}+C${r}+D${r}+E${r})` };
            sheet.getCell(r, 8).value = { formula: `G${r}/F${r}` };
            
            if (Math.abs(p - targetP) < 0.51) sheet.getCell(r, 9).value = 'Regular Price';

            ['B','C','D','F','I'].forEach(col => sheet.getCell(`${col}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } });
            sheet.getCell(`G${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
        }

        // --- 4. VOLUME SCENARIO TABLE ---
        const volHeaders = ['Units/Day', 'Selling Price', 'Daily Revenue', 'Days/Year', 'Annual Revenue', '% of Total', 'Scenario'];
        volHeaders.forEach((h, i) => {
            const cell = sheet.getCell(16, 10 + i); 
            cell.value = h;
            cell.font = beigeText;
            cell.fill = darkGreyFill;
        });

        const mLikely = ai?.mostLikelyUnitsPerDay || 25;
        const volStep = Math.max(1, Math.floor(mLikely / 5));

        for (let i = 0; i < scenarioRowsCount; i++) {
            const r = scenarioStartRow + i;
            const u = Math.max(1, i * volStep);
            sheet.getCell(r, 10).value = u;
            sheet.getCell(r, 11).value = { formula: `INDEX($F$12:$F$${ladderEndRow}, MATCH("Regular Price", $I$12:$I$${ladderEndRow}, 0))` };
            sheet.getCell(r, 12).value = { formula: `J${r}*K${r}` };
            sheet.getCell(r, 13).value = ctx.sellingDaysPerYear;
            sheet.getCell(r, 14).value = { formula: `L${r}*M${r}` };
            sheet.getCell(r, 15).value = { formula: `N${r}/$M$12` }; 
            
            if (u >= mLikely && u < mLikely + volStep) {
                sheet.getCell(r, 16).value = 'Most Likely Scenario';
                for(let c=10; c<=16; c++) sheet.getCell(r, c).fill = yellowFill;
            }
            if (i === scenarioRowsCount - 1) {
                sheet.getCell(r, 16).value = 'Best Case Scenario';
                for(let c=10; c<=16; c++) sheet.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB6D7A8' } };
            }
        }
        
        sheet.getCell(12, 13).value = ctx.six10TrailingRevenue || 25000000;
        sheet.getCell(12, 13).numFmt = '"$"#,##0.00';

        // --- Borders & Widths ---
        sheet.eachRow(row => {
            row.eachCell(cell => {
                cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                if (typeof cell.value === 'number') {
                    if (cell.address.match(/[BFGKLN][0-9]+/)) cell.numFmt = '"$"#,##0.00';
                    if (cell.address.match(/[HMRS][0-9]+/)) cell.numFmt = '0%';
                }
            });
        });

        // Exact Column Widths
        sheet.getColumn(2).width = 25; 
        for(let i=3; i<=8; i++) sheet.getColumn(i).width = 15; 
        sheet.getColumn(10).width = 25; 
        for(let i=11; i<=20; i++) sheet.getColumn(i).width = 18;

        // Conditional Formatting for Gross Margin (H12:H26)
        sheet.addConditionalFormatting({
            ref: `H12:H${ladderEndRow}`,
            rules: [
                { type: 'expression', formulae: ['H12>=0.3'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFB6D7A8' } } } },
                { type: 'expression', formulae: ['H12<0.3'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFEA9999' } } } }
            ]
        });

        await workbook.xlsx.writeFile(xlsxPath);
    }
}

module.exports = new ExcelExporter();
