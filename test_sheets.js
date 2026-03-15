const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function testConnection() {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const relPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || 'credentials/google-service-account.json';
    const credentialsPath = path.isAbsolute(relPath) ? relPath : path.join(__dirname, relPath);

    console.log('--- Google Sheets Connection Test ---');
    console.log(`Sheet ID: ${spreadsheetId}`);
    console.log(`Resolved Path: ${credentialsPath}`);

    if (!spreadsheetId) {
        console.error('❌ Error: GOOGLE_SHEET_ID is missing in .env');
        process.exit(1);
    }

    if (!fs.existsSync(credentialsPath)) {
        console.error(`❌ Error: Credentials file not found at ${credentialsPath}`);
        process.exit(1);
    }

    try {
        const credentials = JSON.parse(fs.readFileSync(credentialsPath));
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.get({ spreadsheetId });
        console.log(`✅ Success! Connected to spreadsheet: "${response.data.properties.title}"`);
        console.log('Sheets found:', response.data.sheets.map(s => s.properties.title).join(', '));
    } catch (error) {
        console.error('❌ Connection Failed:');
        console.error(error.message);
        process.exit(1);
    }
}

testConnection();
