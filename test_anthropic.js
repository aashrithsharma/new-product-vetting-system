require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function test() {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
            generationConfig: { maxOutputTokens: 10, temperature: 0 }
        });
        const result = await model.generateContent('Say hi');
        console.log("Success:", result.response.text());
    } catch (e) {
        console.log("Status:", e.status);
        console.log("Error Type:", e.errorDetails);
        console.log("Error Msg:", e.message);
    }
}

test();
