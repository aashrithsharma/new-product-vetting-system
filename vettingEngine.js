const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');

class VettingEngine {
    constructor() {
        this.anthropic = null;
        if (process.env.ANTHROPIC_API_KEY) {
            this.anthropic = new Anthropic({ 
                apiKey: process.env.ANTHROPIC_API_KEY.trim(),
                timeout: 60000 // 60 seconds — set at client level, not per-request
            });
        }
    }

    /**
     * Helper to call Claude with the new Sonnet 4 model
     */
    async callClaude(params) {
        if (!this.anthropic) {
            logger.error('[VETTING] ANTHROPIC_API_KEY missing from .env');
            throw new Error('Anthropic API key required.');
        }

        const model = 'claude-sonnet-4-20250514';
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                logger.info(`[VETTING] Calling Claude with model: ${model} (Attempt ${attempts})`);
                return await this.anthropic.messages.create({
                    ...params,
                    model
                });
            } catch (e) {
                const isRetryable = e.status === 529 || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || (e.message && e.message.includes('Connection'));
                if (isRetryable && attempts < maxAttempts) {
                    logger.warn(`[VETTING] Claude call error (${e.status || e.code || 'connection'}). Retrying in ${attempts * 5}s...`);
                    await new Promise(r => setTimeout(r, attempts * 5000));
                    continue;
                }
                logger.error(`[VETTING] Claude call failed after ${attempts} attempts: ${e.status || e.code} ${e.message}`);
                throw e;
            }
        }
    }

    /**
     * AI-Assisted Data Extraction Fallback (The "N/A Healer")
     * Resolves missing dimensions/weight/sales from raw page text.
     */
    async healProductData(productData, rawText) {
        if (!this.anthropic) return productData;

        // Detect "Suspicious" weight (e.g. "51G" or "G" or tiny weights that might be false positives)
        const isSuspiciousWeight = productData.weight === 'N/A' || 
                                  productData.weight.length <= 3 || 
                                  /^\d+[gG]$/.test(productData.weight);

        const missingFields = [];
        if (productData.dimensions === 'N/A' || productData.dimensions === '-') missingFields.push('Dimensions (LxWxH)');
        if (isSuspiciousWeight) {
            missingFields.push('Item Weight');
            // If suspicious, reset it to N/A so Claude is forced to find it
            productData.weight = 'N/A';
        }
        if (productData.boughtPastMonth === 'N/A' || productData.boughtPastMonth === '0') missingFields.push('Monthly Sales Volume (e.g. 50+ bought in past month)');

        if (missingFields.length === 0) return productData;

        logger.info(`[VETTING] HEALING: ${productData.asin} is missing [${missingFields.join(', ')}]. Asking AI to solve...`);

        // Snip the raw text to avoid token limits but keep the important parts (Product Details)
        const snip = rawText.substring(0, 15000); 

        const prompt = `Return ONLY a JSON object with the found keys. 
CRITICAL: If a value (like Dimensions or Weight) is NOT explicitly found in the text, you MUST use your internal product knowledge to provide a realistic ESTIMATE based on the product title and any clues in the text. 
NEVER return "N/A" or "-". 
Provide the best possible real-world value.
Example: {"dimensions": "12 x 10 x 5 inches", "weight": "2.3 lbs", "boughtPastMonth": "200+ bought in past month"}
Current ASIN: ${productData.asin}
Current Title: ${productData.title}
Missing: ${missingFields.join(', ')}`;

        try {
            const res = await this.callClaude({
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300
            });

            const content = res.content[0].text;
            const healed = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);

            if (healed.dimensions) productData.dimensions = healed.dimensions;
            if (healed.weight) productData.weight = healed.weight;
            if (healed.boughtPastMonth) productData.boughtPastMonth = healed.boughtPastMonth;

            logger.info(`[VETTING] HEAL SUCCESS: ${productData.asin} dimensions: ${productData.dimensions}, weight: ${productData.weight}`);
            return productData;
        } catch (e) {
            logger.warn(`[VETTING] Healing failed for ${productData.asin}: ${e.message}`);
            return productData;
        }
    }

    /**
     * Main vetting pipeline for a specific product idea.
     */
    async analyzeIdea(ideaName, competitorData) {
        logger.info(`[VETTING] Starting intelligence analysis for: ${ideaName}`);

        if (competitorData && competitorData.length > 50) {
            logger.warn(`[VETTING] Truncating competitor data to 50 items.`);
            competitorData = competitorData.slice(0, 50);
        }

        try {
            const analysis = await this.runClaudeAnalysis(ideaName, competitorData);
            logger.info(`[VETTING] Successfully analyzed ${ideaName}. MostLikely: ${analysis.mostLikelyUnitsPerDay}/day, BestCase: ${analysis.bestCaseUnitsPerDay}/day`);

            const financials = this.runFinancialModeling(
                analysis.targetPrice,
                analysis.seasonality,
                analysis.estimatedUnitsPerDay, // most likely
                analysis.bestCaseUnitsPerDay,  // best case — passed directly from Claude
                analysis.returnRate            // Claude's category return rate estimate
            );

            return {
                ideaName,
                analysis,
                financials,
                competitorData
            };
        } catch (error) {
            logger.error(`[VETTING] Failed to vet idea ${ideaName}: ${error.message}.`);
            throw error;
        }
    }

    /**
     * Layer 0: Search Query Optimization
     */
    async generateSearchQuery(primaryData) {
        if (!this.anthropic) return primaryData.title?.split(' ').slice(0, 5).join(' ') || 'amazon product';

        const prompt = `You are an Amazon market research expert finding DIRECT competitors.

Product:
- Title: ${primaryData.title}
- Brand: ${primaryData.brand || 'N/A'}
- Price: ${primaryData.price || 'N/A'}
- Category: ${primaryData.category || 'N/A'}

Generate ONE Amazon search query (3-6 words) that finds DIRECT COMPETITORS.
Rules:
1. Focus on product TYPE and USE CASE, not the brand name
2. Include key characteristics (e.g. "pool clarifier liquid", "hair growth serum women")
3. Do NOT include the brand name "${primaryData.brand || ''}" in your query
4. Match what a customer searches when comparing options

Respond with ONLY the search query. No quotes, no explanation.`;

        try {
            const response = await this.callClaude({
                max_tokens: 30,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }]
            });
            const query = response.content[0].text.trim().replace(/["']/g, '');
            logger.info(`[VETTING] Claude competitor search query: "${query}"`);
            return query;
        } catch (e) {
            logger.warn(`[VETTING] Search query generation failed, using title fallback.`);
            return primaryData.title?.split(' ').slice(0, 5).join(' ') || 'amazon product';
        }
    }

    /**
     * Layer 1: Competitor Filtering
     */
    async selectTopCompetitors(primaryData, searchResults) {
        if (!this.anthropic) return searchResults.slice(0, 5);

        const items = searchResults.map(r => ({
            asin: r.asin,
            title: r.name || r.title,
            price: r.price,
            stars: r.stars,
            reviews: r.total_reviews,
            boughtPastMonth: r.sales_volume || r.boughtPastMonth || 'N/A'
        }));

        const prompt = `You are an Amazon competitive intelligence analyst for Six10 Ventures.

Target product to find competitors for:
- Title: "${primaryData.title}"
- Brand: ${primaryData.brand || 'N/A'}
- Price: ${primaryData.price || 'N/A'}

From the search results below, select the TOP 5 DIRECT COMPETITORS.
A direct competitor must:
1. Solve the SAME problem / serve the SAME use case as the target product
2. Be in the same product format (e.g., liquid, capsule, spray, kit — must match)
3. Be priced within a similar range (not wildly different)
4. NOT be accessories, bundles, or completely unrelated products

Search results:
${JSON.stringify(items, null, 2)}

Respond ONLY with a JSON array of up to 7 ASINs (or fewer if not enough qualify).
Example: ["B001", "B002", "B003", "B004", "B005", "B006", "B007"]`;

        try {
            const response = await this.callClaude({
                max_tokens: 200,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }]
            });
            const raw = response.content[0].text.trim();
            const match = raw.match(/\[[\s\S]*\]/);
            const asins = JSON.parse(match ? match[0] : raw);
            logger.info(`[VETTING] Claude selected ${asins.length} competitors: ${asins.join(', ')}`);
            return searchResults.filter(r => asins.includes(r.asin)).slice(0, 5);
        } catch (e) {
            logger.warn(`[VETTING] Claude competitor selection fallback used.`);
            return searchResults.slice(0, 5);
        }
    }

    /**
     * Pre-compute deterministic, realistic sales velocity baselines for Six10 product launches.
     *
     * SIX10 DEBRIEF — Dynamic Category Scaling:
     *   - Market volume is product-dependent; we use relative capture instead of hard caps.
     *   - Most Likely (ML): ~10% of Top-3 competitors' price-adjusted volume.
     *   - Best Case (BC):   ~30% of the #1 Market Leader's price-adjusted volume.
     *
     * FORMULA:
     *   1. Badge → raw daily   (e.g. "1K+ bought" → 33/day)
     *   2. BSR multiplier      (Small bump for high-velocity ranking)
     *   3. Price elasticity    (Penalty if price exceeds market, bonus if cheaper)
     *   4. Market Launch Capture:
     *        ML = Average(Top-3 Competitors) × 0.10 (Conservative Entry)
     *        BC = Market Leader × 0.30 (Strong PPC/Viral Launch)
     */
    _computeVelocityBaselines(competitors, targetPrice) {
        const parsed = competitors.map(c => {
            const d = c.data || c;
            const priceRaw = parseFloat(String(d.price || '0').replace(/[^0-9.]/g, '')) || 0;
            const badge    = d.boughtPastMonth || 'N/A';
            const bsr      = parseInt(String(d.bsr || '0').replace(/[^0-9]/g, '')) || 0;

            // Step 1: Badge → baseline daily units
            let badgeDaily = null;
            // Match patterns: "1K+", "5K+", "500+", "1,200", plain numbers
            const badgeMatch = badge.match(/([\d.]+)\s*([Kk])\+?|(\d[\d,]*)\+?/);
            if (badgeMatch) {
                let num;
                if (badgeMatch[1] && badgeMatch[2]) {
                    num = parseFloat(badgeMatch[1]) * 1000; // e.g. 1K = 1000
                } else if (badgeMatch[3]) {
                    num = parseFloat(badgeMatch[3].replace(/,/g, ''));
                }
                if (num && num > 0) badgeDaily = Math.round(num / 30);
            }

            if (badgeDaily === null) return null; // No badge data — skip competitor

            // Step 2: BSR multiplier (small adjustment only)
            let bsrMultiplier = 1.0;
            if (bsr > 0) {
                if      (bsr < 1000)  bsrMultiplier = 1.2;
                else if (bsr < 5000)  bsrMultiplier = 1.1;
                else if (bsr > 50000) bsrMultiplier = 0.85;
            }
            const bsrAdjusted = Math.round(badgeDaily * bsrMultiplier);

            // Step 3: Price elasticity — cap the minimum at 40% to avoid near-zero
            let elasticity = 1.0;
            if (priceRaw > 0 && targetPrice > 0) {
                const priceDiff = targetPrice - priceRaw;
                elasticity = Math.max(0.40, 1 - (priceDiff * 0.04)); // 4% per $1
            }
            const competitorAdjustedDaily = Math.max(1, Math.round(bsrAdjusted * elasticity));

            return {
                asin: d.asin,
                brand: d.brand,
                price: priceRaw,
                bsr,
                badgeDaily,
                bsrAdjusted,
                competitorAdjustedDaily,
                // Dynamic Market Capture Factors (SIX10 RELATIVE CAPTURE)
                // ML: ~30% of market share (Standard Launch) - Updated for manual alignment
                // BC: ~60% of market leader share (Aggressive Launch) - Updated for manual alignment
                launchMostLikely: Math.max(1, Math.round(competitorAdjustedDaily * 0.30)), 
                launchBestCase:   Math.max(1, Math.round(competitorAdjustedDaily * 0.60)) 
            };
        }).filter(Boolean);

        if (parsed.length === 0) {
            logger.warn('[VETTING] No badge data found — using Six10 conservative defaults (15/35).');
            return { mostLikely: 15, bestCase: 35, perCompetitor: [] };
        }

        // Sort by competitorAdjustedDaily descending (strongest to weakest)
        parsed.sort((a, b) => b.competitorAdjustedDaily - a.competitorAdjustedDaily);

        // Most Likely = Average entry capture (10% of top volume)
        const top3 = parsed.slice(0, Math.min(3, parsed.length));
        const mostLikely = Math.round(top3.reduce((s, c) => s + c.launchMostLikely, 0) / top3.length);

        // Best Case = Professional launch capture (30% of market leader)
        const bestCase = parsed[0].launchBestCase;
        
        logger.info(`[VETTING] Dynamic Baseline — Top Comp: ${parsed[0].competitorAdjustedDaily}/day, ML=${mostLikely}/day, BC=${bestCase}/day`);

        return { mostLikely, bestCase, perCompetitor: parsed };
    }

    /**
     * Layer 2: Competitive Intelligence & Research
     */
    async runClaudeAnalysis(ideaName, competitors) {
        // Step 1 — Pre-compute price estimate from competitor average (used in velocity calc)
        const prices = competitors.map(c => {
            return parseFloat(String((c.data || c).price || '0').replace(/[^0-9.]/g, '')) || 0;
        }).filter(p => p > 0);
        const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 25;
        // Preliminary target price estimate (Claude will refine this)
        const estimatedTargetPrice = Math.round(avgPrice * 1.15 * 100) / 100;

        // Step 2 — Pre-compute velocity baselines deterministically
        const velocity = this._computeVelocityBaselines(competitors, estimatedTargetPrice);
        logger.info(`[VETTING] Pre-computed velocity: mostLikely=${velocity.mostLikely}/day, bestCase=${velocity.bestCase}/day`);

        const prompt = `
        You are an expert Amazon product analyst for Six10 Ventures, a moderate-to-premium Amazon brand.
        Analyze the competitor data below for the product idea: "${ideaName}".

        YOUR TASKS:
        1. CLASSIFY each competitor as Budget, Mid-Range, or Premium based on price, reviews, listing quality.
        2. RECOMMEND a Target Selling Price for Six10 — a specific dollar amount positioned between category average and premium tier.
        3. USE THE PRE-COMPUTED DISTRIBUTIONS below. These scale relative to the category depth.
           - PRE-COMPUTED mostLikelyUnitsPerDay: ${velocity.mostLikely}  (30% launch market capture)
           - PRE-COMPUTED bestCaseUnitsPerDay:   ${velocity.bestCase}   (60% share capture of market leader)
           - NOTE: Products with year-round utility (Replenishables like Septic, Cleaners) or Commercial/Professional use (Fog Juice, DJ effects, etc.) MUST be "365". Even if they have a seasonal peak, if they sell every month, use "365". Use "245" only for items with near-zero off-season demand.
        5. BASEBALL CATEGORY based on Annual Revenue vs $25M:
           - Less Than a Single: <$250K/yr | Single: $250K-750K | Double: $750K-1.5M | Triple: $1.5M-2.5M | Homerun: >$2.5M
        6. RETURN RATE: estimated % for this product category (e.g., 0.025 = 2.5%).
        7. FORMAT RESEARCH: RTU vs concentrate, pack size, ingredients, differentiation opportunity.
        8. INTELLIGENCE BRIEF: 3-4 sentences a reviewer can scan in 60 seconds.

        Competitor Data (with pre-computed daily velocity per competitor):
        ${JSON.stringify(competitors.map((c, i) => {
            const d = c.data || c;
            const v = velocity.perCompetitor?.[i];
            return {
                asin: d.asin,
                title: d.title,
                price: d.price,
                stars: d.stars,
                reviews: d.reviews,
                bsr: d.bsr || 'N/A',
                boughtPastMonth: d.boughtPastMonth || 'N/A',
                brand: d.brand,
                computedBadgeDaily: v?.badgeDaily ?? 'N/A',
                computedPriceAdjustedDaily: v?.priceAdjustedDaily ?? 'N/A',
                computedLaunchCapture60pct: v?.launchBestCase ?? 'N/A'
            };
        }), null, 2)}

        CONSTRAINTS:
        - mostLikelyUnitsPerDay must be within ±15% of ${velocity.mostLikely} (range: ${Math.floor(velocity.mostLikely * 0.85)}–${Math.ceil(velocity.mostLikely * 1.15)})
        - bestCaseUnitsPerDay must be within ±15% of ${velocity.bestCase} (range: ${Math.floor(velocity.bestCase * 0.85)}–${Math.ceil(velocity.bestCase * 1.15)}), minimum 41.
        - If you adjust outside this range, explain clearly in salesReasoning why the data justifies it.

        OUTPUT: Respond with ONLY valid raw JSON — no markdown, no explanation, no code blocks.
        {
          "classifications": [{"asin": "B0...", "brand": "Brand", "tier": "Mid-Range", "reasoning": "..."}],
          "targetPrice": 24.99,
          "pricingReasoning": "...",
          "mostLikelyUnitsPerDay": ${velocity.mostLikely},
          "bestCaseUnitsPerDay": ${velocity.bestCase},
          "salesReasoning": "Pre-computed: badge→daily conversion, BSR multiplier, 5%/$ price elasticity, 30% launch factor applied. Adjustments: ...",
          "seasonality": "365",
          "baseballCategory": "Single",
          "returnRate": 0.025,
          "formatResearch": "...",
          "intelligenceBrief": "..."
        }
        `;

        const response = await this.callClaude({
            max_tokens: 2500,
            temperature: 0,
            system: "You are a financial analyst. Output only raw valid JSON with no markdown or code blocks.",
            messages: [{ role: 'user', content: prompt }]
        });

        const rawText = response.content[0].text.trim();
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[0] : rawText;
        const parsed = JSON.parse(jsonStr);

        // Backwards compatibility: keep estimatedUnitsPerDay pointing to mostLikely
        parsed.estimatedUnitsPerDay = parsed.mostLikelyUnitsPerDay || parsed.estimatedUnitsPerDay || velocity.mostLikely;

        // === HARD CLAMP: Enforce ±25% of pre-computed baselines ===
        // This ensures AI drift doesn't cause wildly different outputs run-to-run.
        const clampPct = 0.25;
        const mlMin = Math.floor(velocity.mostLikely * (1 - clampPct));
        const mlMax = Math.ceil(velocity.mostLikely * (1 + clampPct));
        const bcMin = Math.max(5, Math.floor(velocity.bestCase * (1 - clampPct)));
        const bcMax = Math.ceil(velocity.bestCase * (1 + clampPct));

        const rawML = parsed.mostLikelyUnitsPerDay || velocity.mostLikely;
        const rawBC = parsed.bestCaseUnitsPerDay || velocity.bestCase;

        parsed.mostLikelyUnitsPerDay = Math.min(mlMax, Math.max(mlMin, rawML));
        parsed.bestCaseUnitsPerDay   = Math.min(bcMax, Math.max(bcMin, rawBC));
        parsed.estimatedUnitsPerDay  = parsed.mostLikelyUnitsPerDay;

        if (rawML !== parsed.mostLikelyUnitsPerDay || rawBC !== parsed.bestCaseUnitsPerDay) {
            logger.warn(`[VETTING] Claude drifted outside bounds. Clamped: ML ${rawML}→${parsed.mostLikelyUnitsPerDay}, BC ${rawBC}→${parsed.bestCaseUnitsPerDay}`);
        }
        logger.info(`[VETTING] Final velocity: mostLikely=${parsed.mostLikelyUnitsPerDay}/day, bestCase=${parsed.bestCaseUnitsPerDay}/day (pre-computed baseline: ${velocity.mostLikely}/${velocity.bestCase})`);

        return parsed;
    }

    /**
     * Layer 3: Financial Modeling (Automated Calculation)
     * Back-calculates target COGS for 30% margin and 200% ROIC.
     */
    runFinancialModeling(targetSellingPrice, seasonalityStr, estimatedUnits, bestCaseUnits = null, claudeReturnRate = null) {
        const price = parseFloat(targetSellingPrice) || 19.99;
        const days = seasonalityStr === '245' ? 245 : 365;  // Seasonality: 245, Non-Seasonality: 365 (Replenishables = 365)
        const referralRate = 0.15;
        const adSpendPct = 0.20;   // Unified: 20% ad spend as per debrief
        // Use Claude's return rate if provided, else default 2.5%
        const retRate = (claudeReturnRate && claudeReturnRate > 0 && claudeReturnRate < 1)
            ? claudeReturnRate : 0.025;
        const avgInvHolding = 0.5; // Default per debrief
        
        const fbaFee = 4.50;
        const supplierToAmazon = 2.00;   // Fixed $2.00 per debrief
        const storageAndInbound = 1.50;  // Fixed $1.50 per debrief

        const referralFee = price * referralRate;

        // --- Back-calculate COGS ---
        // Spec formula: Max COGS = (Regular_Price × 0.85) - FBA_Fee - 3.50 - (Regular_Price × 0.30)
        //   where 3.50 = supplierToAmazon($2.00) + storageAndInbound($1.50)
        //   simplified: price × 0.55 - FBA - 3.50
        const targetCogsByMargin = (price * 0.85) - fbaFee - (supplierToAmazon + storageAndInbound) - (price * 0.30);
        
        let targetCogs = targetCogsByMargin;
        if (targetCogs < 0) targetCogs = price * 0.10; // Floor: at least 10% of price

        const scenarios = [];
        const trailingRev = 25000000; // $25M denominator per debrief

        // Best case: use Claude's estimate if provided, based purely on the competitive data
        const rawBestCase = bestCaseUnits || Math.max((estimatedUnits || 25) * 2, 41);
        const clampedBestCase = Math.max(rawBestCase, 41); 
        
        // Find the closest odd number to bestCase for the table ceiling
        let tableCeiling = Math.round(clampedBestCase);
        if (tableCeiling % 2 === 0) tableCeiling += 1;

        // Generate scenario table up to the realistic best-case limit
        for (let units = 1; units <= tableCeiling; units += 2) {
            const dailyRev = units * price;
            const annualVolume = units * days;       // Uses correct days (245 or 365)
            const annualRev = dailyRev * days;       // Uses correct days (245 or 365)
            const pctOfRev = (annualRev / trailingRev) * 100;

            // Baseball categories based on $25M (debrief spec exact thresholds by %)
            // < 1%  = Less Than a Single  (<$250,000)
            // 1-3%  = Single              ($250K - $750K)
            // 3-6%  = Double              ($750K - $1.5M)
            // 6-10% = Triple              ($1.5M - $2.5M)
            // >10%  = Homerun             (>$2.5M)
            let baseballCategory = 'Less Than a Single';
            if (annualRev >= 2500000) baseballCategory = 'Homerun';
            else if (annualRev >= 1500000) baseballCategory = 'Triple';
            else if (annualRev >= 750000) baseballCategory = 'Double';
            else if (annualRev >= 250000) baseballCategory = 'Single';

            const isMostLikely = estimatedUnits && Math.abs(units - estimatedUnits) < 2;
            const isBestCase = (units === tableCeiling);

            scenarios.push({
                unitsPerDay: units,
                sellingPrice: price,
                dailyRevenue: parseFloat(dailyRev.toFixed(2)),
                daysPerYear: days,
                annualVolume,
                expectedAnnualRevenue: parseFloat(annualRev.toFixed(2)),
                pctOfTrailingRevenue: parseFloat(pctOfRev.toFixed(4)),
                baseballCategory,
                isMostLikely,
                isBestCase
            });
        }

        // Ensure at least one most likely scenario is marked
        if (!scenarios.some(s => s.isMostLikely) && estimatedUnits) {
            const closest = scenarios.reduce((p, c) =>
                Math.abs(c.unitsPerDay - estimatedUnits) < Math.abs(p.unitsPerDay - estimatedUnits) ? c : p
            );
            closest.isMostLikely = true;
        }

        // --- Annual Summary Metrics (Table 2) ---
        const dailyUnits = estimatedUnits || 25;
        const regularPrice = price;

        // Revenue uses correct seasonality days (not hardcoded 365)
        const annualRevenue = dailyUnits * regularPrice * days;
        const avgInvUnits = dailyUnits * 182.5;       // Per debrief: 182.5 days = 0.5 year
        const avgInvValue = avgInvUnits * targetCogs;  // = (Daily_Units × 182.5) × COGS
        const adSpendTotal = annualRevenue * adSpendPct;

        // Gross Margin % per debrief: (SP × 0.85 - COGS - FBA - 3.50) / SP
        const netProfitPerUnit = (price * 0.85) - targetCogs - fbaFee - (supplierToAmazon + storageAndInbound);
        const grossMarginPct = netProfitPerUnit / regularPrice;

        // Net Margin after Ads % per debrief: (GM% × (1 - ReturnRate)) - AdSpend%
        const netMarginAfterAdsPct = (grossMarginPct * (1 - retRate)) - adSpendPct;

        // Contribution Margin $ per debrief: Revenue × Net_Margin_after_Ads%
        const annualContributionMargin = annualRevenue * netMarginAfterAdsPct;

        // ROIC per debrief: (Contribution_Margin / Avg_Inv_Value) × 100
        const roic = avgInvValue > 0 ? (annualContributionMargin / avgInvValue) * 100 : 0;

        return {
            targetCogs: parseFloat(targetCogs.toFixed(2)),
            fbaFee,
            supplierToAmazon,
            storageAndInbound,
            annualMetrics: {
                dailyUnits,
                regularPrice,
                annualRevenue,
                avgInvUnits,
                avgInvValue,
                adSpendTotal,
                grossMarginPct,
                retRate,
                netMarginAfterAdsPct,
                annualContributionMargin,
                roic,
                leadTimeDays: 60
            },
            scenarios
        };
    }

    /**
     * Emergency fallback for when AI fails or is disabled.
     */
    runLocalModelingFallback(ideaName, price) {
        return {
            ideaName,
            analysis: {
                targetPrice: price || 29.99,
                estimatedUnitsPerDay: 25,
                seasonality: "365",
                baseballCategory: "Single",
                intelligenceBrief: "Local auto-discovery used (AI pending).",
                formatResearch: "Standard"
            },
            financials: this.runFinancialModeling(price || 29.99, "365", 25)
        };
    }
}

module.exports = new VettingEngine();

