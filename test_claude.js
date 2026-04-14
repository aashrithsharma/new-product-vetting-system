require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY.trim(),
    timeout: 120000
});

const model = 'claude-sonnet-4-20250514';

(async () => {
    console.log(`\n🔍 Testing Claude model: ${model}\n`);
    try {
        const res = await client.messages.create({
            model,
            max_tokens: 50,
            messages: [{ role: 'user', content: 'Reply with only: "AI Vetting OK"' }]
        });
        const text = res.content[0].text.trim();
        console.log(`✅ SUCCESS! Model responded: "${text}"\n`);
    } catch (e) {
        console.error(`❌ FAILED: ${e.status || e.code} — ${e.message}\n`);
    }
})();
