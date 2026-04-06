const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });

const models = [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620'
];

async function scan() {
    console.log('--- TESTING UPDATED MODELS ---');
    for (const model of models) {
        try {
            console.log(`Testing ${model}...`);
            const res = await client.messages.create({
                model,
                max_tokens: 10,
                messages: [{ role: 'user', content: 'hi' }]
            });
            console.log(`✅ SUCCESS [${model}]`);
            break; // Stop at first success
        } catch (e) {
            console.log(`❌ FAILED [${model}] ${e.status} ${e.message}`);
        }
    }
}

scan();
