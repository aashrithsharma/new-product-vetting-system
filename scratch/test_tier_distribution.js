require('dotenv').config();
const vettingEngine = require('../vettingEngine');
const logger = require('../logger');

async function runTest() {
    const ideaName = "Wet Platinum Silicone Lubricant Test";
    
    // Simulating the exact scenario from the user's screenshot
    const competitorData = [
        { asin: 'B000DZL33K', price: '$1.34', data: { price: '$1.34', brand: 'Wet' } },
        { asin: 'B017T582ZS', price: '$28.58', data: { price: '$28.58', brand: 'Wet' } },
        { asin: 'B000PRA724', price: '$12.99', data: { price: '$12.99', brand: 'Wet' } },
        { asin: 'B00172NYKI', price: '$46.99', data: { price: '$46.99', brand: 'Wet' } },
        { asin: 'B0OE4MIREG', price: '$19.30', data: { price: '$19.30', brand: 'Wet' } },
        { asin: 'B08KSLV96M', price: '$13.99', data: { price: '$13.99', brand: 'Turn On' } }
    ];

    console.log("=== INTERNAL TIER DISTRIBUTION TEST ===");
    console.log(`Input ASIN Price: $1.34 (Should be filtered as outlier)`);
    console.log(`Expected Result: $46 is Premium, $19/$28 is Mid, $1/$12 is Budget\n`);

    const result = await vettingEngine.runLocalIntelligenceAnalysis(ideaName, competitorData);
    
    console.log("Target Price Anchor:", result.analysis.targetPrice);
    console.log("\nResults Table:");
    console.table(result.analysis.classifications.map(c => ({
        ASIN: c.asin,
        Price: c.price,
        Tier: c.tier,
        Reason: c.reasoning
    })));

    const budgetCount = result.analysis.classifications.filter(c => c.tier === 'Budget').length;
    const midCount = result.analysis.classifications.filter(c => c.tier === 'Mid-Range').length;
    const premiumCount = result.analysis.classifications.filter(c => c.tier === 'Premium').length;

    console.log(`\nFinal Distribution: Budget(${budgetCount}), Mid(${midCount}), Premium(${premiumCount})`);
    
    if (premiumCount > 0 && budgetCount > 0 && midCount > 0) {
        console.log("\n✅ SUCCESS: Distribution is Mixed and Dynamic.");
    } else {
        console.log("\n❌ FAILED: Distribution is still skewed.");
    }
}

runTest();
