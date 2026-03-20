const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const ExcelJS = require('exceljs');
const logger = require('./logger');

/**
 * Downloads an image to a temporary buffer
 */
async function downloadImage(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data, 'binary');
    } catch (error) {
        logger.warn(`[EXPORTER] Image download failed: ${url} - ${error.message}`);
        return null;
    }
}

/**
 * Generates CSV and Excel files from scrape results
 * NEW VERTICAL FORMAT (v5.0)
 */
async function generateOutputs(results, runId) {
    const now = new Date();
    const datePart = now.toISOString().split('T')[0];
    const timePart = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
    const timestamp = `${datePart}-${timePart}`;

    const baseName = `competitor-research-${timestamp}`;
    const baseDir = process.env.VERCEL ? '/tmp/outputs' : 'outputs';
    const csvPath = path.join(baseDir, `${baseName}.csv`);
    const xlsxPath = path.join(baseDir, `${baseName}.xlsx`);

    await fs.ensureDir(baseDir);
    const outputs = {};

    const rows = [
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

    // 1. Generate CSV (Vertical)
    try {
        let csvLines = [];
        for (const row of rows) {
            let line = [`"${row.label}"`];
            for (const r of results) {
                let val = '';
                if (row.key === 'originalUrl') val = r.originalUrl || '';
                else if (row.key === 'asin') val = r.asin || '';
                else val = r.data ? r.data[row.key] : 'N/A';
                
                // Escape quotes for CSV
                line.push(`"${String(val || '').replace(/"/g, '""')}"`);
            }
            csvLines.push(line.join(','));
        }
        await fs.writeFile(csvPath, csvLines.join('\n'));
        logger.info(`[EXPORTER] CSV generated (Vertical): ${csvPath}`);
        outputs.csv = csvPath;
    } catch (error) {
        logger.error(`[EXPORTER] Error generating CSV: ${error.message}`);
    }

    // 2. Generate Excel (Vertical with Images)
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Research');

        // Setup Labels Column (A)
        sheet.getColumn(1).width = 20;
        sheet.getColumn(1).font = { bold: true };
        
        // Setup Product Columns (B, C, D...)
        results.forEach((r, idx) => {
            sheet.getColumn(idx + 2).width = 25;
            sheet.getColumn(idx + 2).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        });

        // Write Labels and Data
        for (let i = 0; i < rows.length; i++) {
            const rowIndex = i + 1;
            const rowDef = rows[i];
            const row = sheet.getRow(rowIndex);
            
            row.getCell(1).value = rowDef.label;
            row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECECEC' } };

            if (rowDef.label === 'Product Image') {
                row.height = 80;
            }

            for (let j = 0; j < results.length; j++) {
                const r = results[j];
                const colIndex = j + 2;
                const cell = row.getCell(colIndex);

                let val = '';
                if (rowDef.key === 'originalUrl') val = r.originalUrl || '';
                else if (rowDef.key === 'asin') val = r.asin || '';
                else val = r.data ? r.data[rowDef.key] : 'N/A';

                if (rowDef.label === 'Product Image' && r.status === 'SUCCESS' && r.data?.imageUrl) {
                    const imgBuffer = await downloadImage(r.data.imageUrl);
                    if (imgBuffer) {
                        try {
                            const imageId = workbook.addImage({
                                buffer: imgBuffer,
                                extension: 'jpeg',
                            });
                            sheet.addImage(imageId, {
                                tl: { col: colIndex - 1, row: rowIndex - 1 },
                                ext: { width: 100, height: 100 },
                                editAs: 'oneCell'
                            });
                            cell.value = ''; // Clear text if image added
                        } catch (imgError) {
                            cell.value = r.data.imageUrl;
                        }
                    } else {
                        cell.value = r.data.imageUrl;
                    }
                } else if (rowDef.label === 'Selling Price' && val.includes('check proxy')) {
                    cell.value = val;
                    cell.font = { color: { argb: 'FFFF0000' }, bold: true };
                } else {
                    cell.value = val;
                }
            }
        }

        // Global formatting
        sheet.eachRow((row) => {
            row.eachCell((cell) => {
                cell.border = {
                    top: { style: 'thin' },
                    left: { style: 'thin' },
                    bottom: { style: 'thin' },
                    right: { style: 'thin' }
                };
            });
        });

        await workbook.xlsx.writeFile(xlsxPath);
        logger.info(`[EXPORTER] Excel generated (Vertical + Images): ${xlsxPath}`);
        outputs.xlsx = xlsxPath;
    } catch (error) {
        logger.error(`[EXPORTER] Error generating Excel: ${error.message} - ${error.stack}`);
    }

    return outputs;
}

module.exports = { generateOutputs };
