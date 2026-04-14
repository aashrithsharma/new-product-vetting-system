/**
 * Internal Test — Full Pipeline Validation
 * ASIN: B001L1R3SO (SeaKlear Pool Clarifier)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const orchestrator = require('../orchestrator');

const TEST_ASIN = 'B001L1R3SO';
const IDEA_NAME = 'Pool Clarifier';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTest() {
    console.log('\n========================================');
    console.log('  INTERNAL PIPELINE TEST');
    console.log(`  ASIN: ${TEST_ASIN} | Idea: ${IDEA_NAME}`);
    console.log('========================================\n');

    // Correct call signature: single destructured object
    const runId = await orchestrator.startRun({
        products: [{ asin: TEST_ASIN, domain: 'amazon.com' }],
        ideaName: IDEA_NAME,
        vettingEnabled: true,
        writeToSheets: false,
        formats: []
    });

    console.log(`[START] Run ID: ${runId} — monitoring (checks every 10s)...\n`);

    let tick = 0;
    while (true) {
        await sleep(10000);
        tick++;
        const state = orchestrator.getRunState(runId);
        if (!state) { console.error('[ERROR] runId not found!'); break; }

        const pct = state.totalAsins > 0
            ? Math.round((state.completedAsins / state.totalAsins) * 100) : 0;

        process.stdout.write(
            `\r[${String(tick * 10).padStart(4)}s] ${state.status.padEnd(10)} | ${state.completedAsins}/${state.totalAsins} ASINs (${pct}%) | Succeeded: ${state.succeededAsins}   `
        );

        const terminal = ['complete', 'failed', 'cancelled'];
        if (terminal.includes(state.status)) break;

        // Safety: 12 minute timeout
        if (tick > 72) {
            console.log('\n[WARN] Timeout — forcing final report...');
            break;
        }
    }

    const finalState = orchestrator.getRunState(runId);
    console.log('\n');

    // --- LOGS ---
    const logs = (finalState.logLines || []).slice(-25);
    console.log('--- LAST 25 LOG ENTRIES ---');
    logs.forEach(l => console.log(`  [${l.type.padEnd(5)}] ${l.message}`));
    console.log('');

    // --- SCRAPE RESULTS ---
    console.log('--- SCRAPE RESULTS ---');
    let allGood = true;
    for (const r of (finalState.results || [])) {
        const d = r.data || {};
        const hasDim    = d.dimensions && d.dimensions !== 'N/A' && d.dimensions !== '-';
        const hasWeight = d.weight     && d.weight     !== 'N/A' && d.weight     !== '-';
        const ok        = r.status === 'SUCCESS' && hasDim && hasWeight;
        if (!ok) allGood = false;

        const icon = ok ? '✓' : '✗';
        console.log(`  [${icon}] ${r.asin} | Status: ${r.status}`);
        console.log(`       Brand:      ${d.brand || 'N/A'}`);
        console.log(`       Price:      ${d.price || 'N/A'}`);
        console.log(`       Stars/Rev:  ★${d.stars || '?'} | ${d.reviews || '?'} reviews`);
        console.log(`       Dimensions: ${d.dimensions || 'MISSING'}`);
        console.log(`       Weight:     ${d.weight || 'MISSING'}`);
        console.log(`       Sales/mo:   ${d.boughtPastMonth || 'N/A'}`);
        console.log('');
    }

    // --- AI VETTING ---
    console.log('--- AI VETTING ---');
    const v = finalState.vettingResults;
    if (v) {
        const a = v.analysis || v;
        console.log(`  ✓ Target Price:     $${a.targetPrice}`);
        console.log(`  ✓ Seasonality:      ${a.seasonality} days`);
        console.log(`  ✓ Units/Day (ML):   ${a.estimatedUnitsPerDay}`);
        console.log(`  ✓ Units/Day (BC):   ${a.bestCaseUnitsPerDay}`);
        console.log(`  ✓ Return Rate:      ${a.returnRate}%`);
        console.log(`  ✓ Intelligence:     ${a.intelligenceBrief ? a.intelligenceBrief.substring(0, 120) + '...' : 'N/A'}`);
    } else {
        console.log('  ✗ AI Vetting returned null');
        allGood = false;
    }

    console.log('\n========================================');
    console.log(`  STATUS:  ${finalState.status.toUpperCase()}`);
    console.log(`  OVERALL: ${allGood ? '✅  100% SUCCESS — All data fields populated' : '⚠️   Some fields missing — see log above'}`);
    console.log('========================================\n');

    process.exit(0);
}

runTest().catch(err => {
    console.error('\n[FATAL ERROR]', err.message);
    console.error(err.stack);
    process.exit(1);
});
