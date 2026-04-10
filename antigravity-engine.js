const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');

class AntigravityEngine {
    constructor() {
        this.anthropic = null;
        if (process.env.ANTHROPIC_API_KEY) {
            this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });
        }
    }

    async analyzeIdea(ideaName, competitorData, context = {}) {
        if (!this.anthropic) {
            logger.error('[ANTIGRAVITY] Missing ANTHROPIC_API_KEY in .env');
            throw new Error('Anthropic API key required.');
        }

        logger.info(`[ANTIGRAVITY] Starting product analysis for: ${ideaName}`);

        const defaults = {
            six10TrailingRevenue: 28000000,
            adSpendRate: 0.20,
            sellingDaysPerYear: 365,
            returnRate: 0.04,
            avgInventoryHolding: 2.85,
            leadTimeDays: 60,
            supplierToWarehouseShipping: 1.25
        };

        const ctx = { ...defaults, ...context };
        const model = 'claude-sonnet-4-20250514';

        const prompt = `You are an expert product analyst for Six10 Ventures.
        Analyze category: "${ideaName}".
        Context: ${JSON.stringify(ctx, null, 2)}
        Competitors: ${JSON.stringify(competitorData.slice(0, 5), null, 2)}
        Return JSON ONLY.`;

        try {
            const response = await this.anthropic.messages.create({
                model,
                max_tokens: 4000,
                temperature: 0,
                system: "Output raw valid JSON only.",
                messages: [{ role: 'user', content: prompt }]
            });

            const rawText = response.content[0].text.trim();
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            const jsonStr = jsonMatch ? jsonMatch[0] : rawText;
            const analysis = JSON.parse(jsonStr);

            return { ideaName, analysis, context: ctx, competitorData };
        } catch (error) {
            logger.error(`[ANTIGRAVITY] Failed analysis for ${ideaName}: ${error.message}`);
            throw error;
        }
    }
}

module.exports = new AntigravityEngine();
