require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());

const models = [
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
];

async function scan() {
    console.log('--- TESTING GEMINI MODELS ---');
    for (const modelName of models) {
        try {
            console.log(`Testing ${modelName}...`);
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: { maxOutputTokens: 10, temperature: 0 }
            });
            const result = await model.generateContent('hi');
            console.log(`✅ SUCCESS [${modelName}]: ${result.response.text().trim()}`);
            break; // Stop at first success
        } catch (e) {
            console.log(`❌ FAILED [${modelName}] ${e.status} ${e.message}`);
        }
    }
}

scan();
