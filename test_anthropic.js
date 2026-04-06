require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

async function test() {
    try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const res = await anthropic.messages.create({
            model: 'claude-3-haiku-20240307',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Say hi' }]
        });
        console.log("Success:", res.content[0].text);
    } catch (e) {
        console.log("Status:", e.status);
        console.log("Error Type:", e.type);
        console.log("Error Msg:", e.message);
    }
}

test();
