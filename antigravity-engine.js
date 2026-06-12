const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('./logger');

class AntigravityEngine {
    constructor() {
        this.gemini = null;
        if (process.env.GEMINI_API_KEY) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
            this.gemini = genAI;
        }
    }

    async analyzeIdea(ideaName, competitorData, context = {}) {
        if (!this.gemini) {
            logger.error('[ANTIGRAVITY] Missing GEMINI_API_KEY in .env');
            throw new Error('Gemini API key required.');
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
        const modelName = 'gemini-2.5-flash';

        const systemInstructions = "Output raw valid JSON only.";
        const userPrompt = `You are an expert product analyst for Six10 Ventures.
        Analyze category: "${ideaName}".
        Context: ${JSON.stringify(ctx, null, 2)}
        Competitors: ${JSON.stringify(competitorData.slice(0, 5), null, 2)}
        Return JSON ONLY.`;

        const fullPrompt = `${systemInstructions}\n\n${userPrompt}`;

        try {
            const model = this.gemini.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    maxOutputTokens: 4000,
                    temperature: 0
                }
            });

            const result = await model.generateContent(fullPrompt);
            const rawText = result.response.text().trim();
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
