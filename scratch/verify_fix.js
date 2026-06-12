const vettingEngine = require('../vettingEngine');

async function verifyLogic() {
    console.log('==========================================');
    console.log('INTERNAL LOGIC VERIFICATION');
    console.log('==========================================\n');

    // MOCK DATA: Rid-X Liquid Septic (Leader at ~33 units/day, $10.99)
    const mockCompetitors = [
        { data: { asin: 'B000H5T70C', title: 'Roebic $10 Leader', price: '10.99', boughtPastMonth: '1K+ bought' } },
        { data: { asin: 'B000BQWJXO', title: 'Roebic $17 Runner Up', price: '17.58', boughtPastMonth: '500+ bought' } },
        { data: { asin: 'B0F32QTSXS', title: 'Rid-X Premium', price: '23.56', boughtPastMonth: '300+ bought' } }
    ];

    const targetPrice = 23.99;
    const ideaName = 'Septic Liquid';

    console.log(`Input: Target Price $${targetPrice} for ${ideaName}`);

    // Pre-compute baseline to see the targets
    const velocity = vettingEngine._computeVelocityBaselines(mockCompetitors, targetPrice);
    
    console.log('\n--- TARGET CALCULATION VERIFICATION ---');
    console.log(`Pre-computed ML: ${velocity.mostLikely} units/day (Targeting ~35% of avg)`);
    console.log(`Pre-computed BC: ${velocity.bestCase} units/day (Targeting ~50% of leader)`);

    // Run full financial modeling
    const financials = vettingEngine.runFinancialModeling(targetPrice, '365', velocity.mostLikely, velocity.bestCase, 0.025, ideaName, mockCompetitors[2].data);

    console.log('\n--- FINANCIAL TARGET VERIFICATION (Table 2) ---');
    console.log(`Dynamic FBA Fee: $${financials.fbaFee.toFixed(2)}`);
    console.log(`Target COGS: $${financials.targetCogs.toFixed(2)}`);
    console.log(`Gross Margin: ${(financials.annualMetrics.grossMarginPct * 100).toFixed(1)}% (Goal: 30%)`);
    console.log(`ROIC: ${financials.annualMetrics.roic.toFixed(1)}% (Goal: 200%+)`);

    console.log('\n--- SCENARIO LABELING VERIFICATION (Table 3) ---');
    const scenarios = financials.scenarios;
    const mlLabel = scenarios.find(s => s.isMostLikely);
    const bcLabel = scenarios.find(s => s.isBestCase);
    const allML = scenarios.filter(s => s.isMostLikely);
    
    console.log(`Expected ML: ${velocity.mostLikely} | Matched Row: ${mlLabel ? mlLabel.unitsPerDay : 'NONE'}`);
    console.log(`Expected BC: ${velocity.bestCase} | Matched Row: ${bcLabel ? bcLabel.unitsPerDay : 'NONE'}`);
    console.log(`Number of 'Most Likely' labels: ${allML.length} (Goal: 1)`);

    if (allML.length === 1 && financials.annualMetrics.grossMarginPct >= 0.29) {
        console.log('\n✅ VERIFICATION SUCCESSFUL: Math and Labeling are accurate.');
    } else {
        console.log('\n❌ VERIFICATION FAILED: Check logic.');
    }
}

verifyLogic();
