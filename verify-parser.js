const { extractAsin } = require('./urlParser');

const testCases = [
    { input: "B000VX7HKW", expected: "B000VX7HKW" },
    { input: "https://www.amazon.com/dp/B000VX7HKW", expected: "B000VX7HKW" },
    { input: "HTTPS://WWW.AMAZON.COM/DP/B000UOJGME", expected: "B000UOJGME" },
    { input: ". https://www.amazon.com/Leather-Honey-Conditioner-Furniture-Accessories/dp/B003IS3HV0/", expected: "B003IS3HV0" },
    { input: "https://www.amazon.com/GREEN-GOBBLER-WASHING-TECHNOLOGY-DEODORIZER/DP/B0DB6NJR8M/?_ENCODING=UTF8&TH=1", expected: "B0DB6NJR8M" },
    { input: "https://www.amazon.com/WASHING-MACHINE-CLEANER-TABLETS-OWNERS/DP/B0DX24WXHJ/", expected: "B0DX24WXHJ" },
    { input: "Just an ASIN B00GRT125A in a sentence", expected: "B00GRT125A" }
];

console.log("=== urlParser v3.3 Test ===");
let passed = 0;
testCases.forEach((tc, i) => {
    const result = extractAsin(tc.input);
    const isMatch = result === tc.expected;
    if (isMatch) passed++;
    console.log(`[${isMatch ? "PASS" : "FAIL"}] Case ${i + 1}: "${tc.input}" -> ${result} (Expected: ${tc.expected})`);
});

console.log(`\nResult: ${passed}/${testCases.length} passed.`);
if (passed === testCases.length) {
    process.exit(0);
} else {
    process.exit(1);
}
