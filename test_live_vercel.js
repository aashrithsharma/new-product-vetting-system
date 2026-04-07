const inputASIN = 'B09CQJ6M6P'; 
const vercelUrl = 'https://six10-p2-1myu6pg31-sharma-rs-projects.vercel.app';
const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + Buffer.from('admin:admin123').toString('base64')
};

async function testVercel() {
    console.log(`Starting live Vercel test for ASIN: ${inputASIN} on ${vercelUrl}`);
    
    try {
        const fetch = (await import('node-fetch')).default;
        
        console.log(`Sending POST request to ${vercelUrl}/api/scrape...`);
        const startRes = await fetch(`${vercelUrl}/api/scrape`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
                mode: 'asins',
                asins: [inputASIN],
                formats: ['csv', 'xlsx'],
                writeToSheets: false, // Don't write to sheets during test
                vettingEnabled: true,
                ideaName: 'Vercel Remote Test',
                triggerSource: 'remote_test'
            })
        });

        const startText = await startRes.text();
        console.log(`POST response status: ${startRes.status}`);
        
        let startData;
        try {
            startData = JSON.parse(startText);
        } catch (e) {
            console.error('Failed to parse POST response as JSON. Raw response:');
            console.error(startText);
            return;
        }

        if (!startRes.ok) {
            console.error('API failed to start scrape:', startData);
            return;
        }

        const runId = startData.runId;
        console.log(`Successfully started scrape on Vercel. Run ID: ${runId}`);
        
        let isComplete = false;
        let failCount = 0;
        
        while (!isComplete) {
            await new Promise(r => setTimeout(r, 2000)); // Poll every 2s like UI
            
            try {
                const progressRes = await fetch(`${vercelUrl}/api/scrape/${runId}/progress`);
                const progText = await progressRes.text();
                
                let progressData;
                try {
                    progressData = JSON.parse(progText);
                } catch(e) {
                    console.log(`[POLL] Vercel returned non-JSON (HTML/504?): ${progText.substring(0,60)}...`);
                    continue;
                }
                
                if (progressData.error) {
                    console.log(`[POLL] Vercel returned JSON Error: ${progressData.error}`);
                    continue;
                }

                if (typeof progressData.completedAsins === 'undefined') {
                    console.log(`[POLL] Invalid State Object missing completedAsins (Keys: ${Object.keys(progressData).join(',')})`);
                    continue;
                }
                
                const percent = ((progressData.completedAsins / progressData.totalAsins) * 100).toFixed(1);
                console.log(`Live Progress: ${percent}% | Completed: ${progressData.completedAsins}/${progressData.totalAsins}`);
                
                if (progressData.logLines && progressData.logLines.length > 0) {
                    const latestLog = progressData.logLines[progressData.logLines.length - 1];
                    console.log(`    > [${latestLog.type}] ${latestLog.message}`);
                }

                if (progressData.isComplete || progressData.status === 'failed' || progressData.status === 'cancelled') {
                    console.log('\n--- VERCEL SCRAPE FINISHED ---');
                    console.log('Final Status:', progressData.status);
                    
                    if (progressData.results && progressData.results.length > 0) {
                        for (const res of progressData.results) {
                            if (res.status === 'SUCCESS') {
                                console.log(`\nASIN: ${res.asin} | Brand: ${res.data.brand} | Price: ${res.data.price}`);
                                console.log(`BSR: ${res.data.bsr}`);
                                console.log(`Dim: ${res.data.dimensions} | Weight: ${res.data.weight}`);
                            }
                        }
                    }
                    isComplete = true;
                }
            } catch (pollErr) {
                console.log(`[POLL] Network fetch exception! ${pollErr.message}`);
            }
        }
    } catch (e) {
        console.error('Test execution failed:', e);
    }
}

testVercel();
