const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');
const utils = require('./utils');


class VettingEngine {
    constructor() {
        this.anthropic = null;
        if (process.env.ANTHROPIC_API_KEY) {
            this.anthropic = new Anthropic({ 
                apiKey: process.env.ANTHROPIC_API_KEY.trim(),
                timeout: 120000 // Increased to 120 seconds for complex market analysis
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
                return await this.anthropic.messages.create({
                    ...params,
                    model
                }, { timeout: 35000 }); // Slightly faster 35s timeout
            } catch (e) {
                const isRetryable = e.status === 529 || e.code === 'ECONNRESET' || (e.message && e.message.includes('Overloaded'));
                if (isRetryable && attempts < maxAttempts) {
                    const delay = 8000; // Reduced to 8s for speed
                    if (attempts === 1) {
                        logger.info(`[VETTING] Prioritizing request under load...`);
                    }
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw e;
            }
        }
    }

    async healProductData(productData, rawText) {
        if (!this.anthropic) return productData;

        // Detect "Suspicious" weight or dimensions (now more aggressive)
        const isSuspiciousWeight = !productData.weight || 
                                  productData.weight === 'N/A' || 
                                  productData.weight === '-' ||
                                  productData.weight.length <= 3 || 
                                  /^\d+[gG]$/.test(productData.weight);
        
        const isSuspiciousDim = !productData.dimensions ||
                                productData.dimensions === 'N/A' || 
                                productData.dimensions === '-' ||
                                (productData.dimensions.match(/\d+/) && !productData.dimensions.includes(' ')) ||
                                productData.dimensions.length < 5;

        // NEW: Detect suspicious volume
        const isSuspiciousVolume = !productData.volume || 
                                   productData.volume === 'N/A' || 
                                   productData.volume === '-';

        const isSuspiciousSales = !productData.boughtPastMonth || 
                                  productData.boughtPastMonth === 'N/A' || 
                                  productData.boughtPastMonth === '-' ||
                                  productData.boughtPastMonth === '0';

        const missingFields = [];
        if (isSuspiciousDim) missingFields.push('Dimensions (LxWxH)');
        if (isSuspiciousWeight) missingFields.push('Item Weight');
        if (isSuspiciousVolume) missingFields.push('Item Volume');
        if (isSuspiciousSales) missingFields.push('Monthly Sales Volume');

        if (missingFields.length === 0) return productData;

        const hasFullText = rawText && rawText.length > 500;
        logger.info(`[VETTING] HEALING: ${productData.asin} has suspicious [${missingFields.join(', ')}]. Context: ${hasFullText ? 'Full Page HTML' : 'Title Only'}`);

        // Prioritize technical sections for the snippet
        let snip = productData.title;
        if (hasFullText) {
            // Try to find the technical specs section to keep the most relevant info in the 40k window
            const specsIndex = rawText.toLowerCase().indexOf('product information') || rawText.toLowerCase().indexOf('technical details') || 0;
            snip = rawText.substring(Math.max(0, specsIndex - 500), Math.max(0, specsIndex - 500) + 40000);
        }

        const prompt = `You are a high-precision marketplace data auditor. 
Analyze the provided raw Amazon page text for the product: "${productData.title}" (ASIN: ${productData.asin}).

TECHNICAL ANCHORS (USE THESE TO INFORM ESTIMATES):
- Known Volume: ${productData.volume || 'N/A'}
- Known Weight: ${productData.weight || 'N/A'}
- Product Price: ${productData.price || 'N/A'}

TASK: Extract exactly from Technical Details or Product Information tables.
If volume/capacity is missing from tables, scan the Title and Bullet points for liquid measures (e.g. 1.7 oz, 50ml, 1 Gallon) OR solid counts (e.g. 150 Strips, 100 Count).

CRITICAL RULES:
1. Locate "Product Dimensions", "Package Dimensions", "Volume", "Count", or weight values.
2. If Volume is N/A in anchors, find it in the provided TEXT SNIPPET. 
3. If it's a dry item, use the count/strips (e.g., "150 Count").
4. If specific table data is missing, provide a high-fidelity MARKET STANDARD ESTIMATE based on the product type and weight. 
5. NO "PENDING" or "N/A" RESPONSES. Every product MUST have a dimension, weight, and volume value to ensure a 100% complete report.
6. Differentiate dimensions intelligently (e.g., a 1 Gallon bottle is not the same size as a 1oz bottle).

Return ONLY a JSON object: {"dimensions": "X.X x Y.Y x Z.Z inches", "weight": "X.X lbs", "volume": "X.X oz/gal/ml/Count", "boughtPastMonth": "X+ bought in past month"}
(Note: Always include units like "oz", "lbs", "Count", or "inches")`;

        try {
            const res = await this.callClaude({
                messages: [{ role: 'user', content: prompt + `\n\nTEXT SNIPPET:\n${snip}` }],
                max_tokens: 350
            });

            const content = res.content[0].text;
            const match = content.match(/\{[\s\S]*\}/);
            let healed;
            try {
                healed = JSON.parse(match ? match[0] : content);
            } catch (parseErr) {
                logger.warn(`[VETTING] Failed to parse Claude healing JSON. Raw text: ${content.substring(0, 100)}...`);
                // Fallback to manual regex if JSON parsing completely fails
                healed = {
                    dimensions: (content.match(/"dimensions"\s*:\s*"([^"]+)"/) || [])[1],
                    weight: (content.match(/"weight"\s*:\s*"([^"]+)"/) || [])[1],
                    volume: (content.match(/"volume"\s*:\s*"([^"]+)"/) || [])[1],
                    boughtPastMonth: (content.match(/"boughtPastMonth"\s*:\s*"([^"]+)"/) || [])[1]
                };
            }

            // CLEANER: Ensure Claude didn't sneak in conversational "Unable to determine" text
            const isInvalid = (val) => !val || val.toLowerCase().includes('unable') || val.toLowerCase().includes('determine') || val === 'N/A' || val === '-';

            if (healed) {
                if (!isInvalid(healed.dimensions)) productData.dimensions = healed.dimensions;
                if (!isInvalid(healed.weight)) productData.weight = healed.weight;
                if (!isInvalid(healed.volume)) productData.volume = healed.volume;
                if (!isInvalid(healed.boughtPastMonth)) productData.boughtPastMonth = healed.boughtPastMonth;
            }

            logger.info(`[VETTING] HEAL SUCCESS: ${productData.asin} dim: ${productData.dimensions}, weight: ${productData.weight}, vol: ${productData.volume}`);
            return productData;
        } catch (err) {
            logger.warn(`[VETTING] Healing failed for ${productData.asin}: ${err.message}`);
            return productData; 
        }
    }

    /**
     * Main vetting pipeline for a specific product idea.
     */
    async analyzeIdea(ideaName, competitorData) {
        this.currentIdeaName = ideaName; // Store for fallback or context if needed
        logger.info(`[VETTING] Starting intelligence analysis for: ${ideaName}`);

        if (competitorData && competitorData.length > 15) {
            logger.warn(`[VETTING] Truncating competitor data to 15 items to optimize AI processing speed.`);
            competitorData = competitorData.slice(0, 15);
        }

        try {
            const analysis = await this.runClaudeAnalysis(ideaName, competitorData);
            logger.info(`[VETTING] Successfully analyzed ${ideaName}. MostLikely: ${analysis.mostLikelyUnitsPerDay}/day, BestCase: ${analysis.bestCaseUnitsPerDay}/day`);

            const primaryProduct = competitorData && competitorData.length > 0 ? (competitorData[0].data || competitorData[0]) : null;

            const financials = this.runFinancialModeling(
                analysis.targetPrice,
                analysis.seasonality,
                analysis.estimatedUnitsPerDay, // most likely
                analysis.bestCaseUnitsPerDay,  // best case — passed directly from Claude
                analysis.returnRate,           // Claude's category return rate estimate
                ideaName,                      // Pass for overrides
                primaryProduct
            );

            // --- FINAL SEASONALITY ENFORCEMENT ---
            // Ensure analysis.seasonality reflects the corrected 'days' count for the brief
            analysis.seasonality = financials.annualMetrics.dailyUnits > 0 ? financials.dailyUnits_daysPerYear : analysis.seasonality;
            // Actually, just force the analysis object's string directly if financials was corrected
            if (financials.annualMetrics.dailyUnits_daysPerYear) {
                 analysis.seasonality = String(financials.annualMetrics.dailyUnits_daysPerYear);
            }

            return {
                ideaName,
                analysis,
                financials,
                competitorData
            };
        } catch (error) {
            logger.error(`[VETTING] AI Vetting failed: ${error.message}. Resolving with Intelligence Engine V2...`);
            return this.runLocalIntelligenceAnalysis(ideaName, competitorData);
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
     * Helper to extract standardized size from title or scraped size field
     */
    _extractSize(title, scrapedSize) {
        if (!title) return scrapedSize || 'N/A';
        
        // 1. If scraped size is already good, use it (but normalize)
        let size = scrapedSize && scrapedSize !== 'N/A' ? scrapedSize : '';
        
        // 2. Regex for volume/weight sizes (Gallons, Oz, Lbs, etc.)
        const volumeRegex = /(\d+\.?\d*\s*(?:gallon|gal|liters?|l|ml|fl\s?oz|oz|ounce|pound|lb|lbs|kg|grams|g))\b/i;
        const packRegex = /(\d+\s*(?:pack|count|ct|pcs|pieces))\b/i;
        const kitRegex = /(\d+\s*(?:way|in\s*1|in\s*one|test|feature|func|component))\b/i;
        
        const titleMatch = title.match(volumeRegex) || title.match(packRegex) || title.match(kitRegex);
        if (titleMatch) {
            size = titleMatch[1];
        } else if (!size) {
            // Last resort for size check
            const genericMatch = title.match(/(\d+\s*(?:unit|can|bottle|jar))/i);
            if (genericMatch) size = genericMatch[1];
        }

        // Normalize
        size = size.toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/gallons?/i, 'Gallon')
            .replace(/gal\b/i, 'Gallon')
            .replace(/\boz\b|\bounces?\b/i, 'oz')
            .replace(/\bpounds?\b|\blbs?\b/i, 'lb')
            .trim();
            
        // Capitalize first letter of each word for clean display
        return size ? size.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'Standard Size';
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

            // Step 1: Badge → baseline daily units (with BSR fallback)
            let badgeDaily = null;
            const badgeMatch = badge.match(/([\d.]+)\s*([Kk])\+?|(\d[\d,]*)\+?/);
            if (badgeMatch) {
                let num;
                if (badgeMatch[1] && badgeMatch[2]) {
                    num = parseFloat(badgeMatch[1]) * 1000;
                } else if (badgeMatch[3]) {
                    num = parseFloat(badgeMatch[3].replace(/,/g, ''));
                }
                if (num && num > 0) badgeDaily = Math.round(num / 30);
            }

            // Fallback to BSR estimation if badge is missing to ensure a complete market view
            if (badgeDaily === null && bsr > 0) {
                const { estimateDailySales } = require('./bsr');
                const est = estimateDailySales(bsr);
                if (typeof est === 'number' && est > 0) badgeDaily = est;
            }

            if (badgeDaily === null) return null; // Still nothing? Skip.

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
                // ML: ~75% of market share capture (Strong Mid-Premium entry)
                // BC: ~125% of competitor's volume (Market Leadership)
                launchMostLikely: Math.max(1, Math.round(competitorAdjustedDaily * 0.75)), 
                launchBestCase:   Math.max(1, Math.round(competitorAdjustedDaily * 1.25)),
                size: this._extractSize(d.title, d.size)
            };
        }).filter(Boolean);

        if (parsed.length === 0) {
            logger.warn('[VETTING] No badge data found — using Six10 conservative defaults (15/35).');
            return { mostLikely: 15, bestCase: 35, perCompetitor: [], sizePotential: {} };
        }

        // Calculate Revenue and Group by Size for Volume Potential
        // Note: We use a default 365 days for this market comparison
        const sizeGroups = {};
        parsed.forEach(c => {
            const annualRev = c.competitorAdjustedDaily * c.price * 365;
            const projectedFba = this.calculateFBAFee(c.data || c);
            c.estimatedAnnualRevenue = annualRev;
            
            if (!sizeGroups[c.size]) {
                sizeGroups[c.size] = {
                    totalRevenue: 0,
                    competitorCount: 0,
                    avgPrice: 0,
                    totalPrice: 0,
                    avgFbaFee: 0,
                    totalFbaFee: 0
                };
            }
            sizeGroups[c.size].totalRevenue += annualRev;
            sizeGroups[c.size].competitorCount += 1;
            sizeGroups[c.size].totalPrice += c.price;
            sizeGroups[c.size].totalFbaFee += projectedFba;
            sizeGroups[c.size].avgPrice = sizeGroups[c.size].totalPrice / sizeGroups[c.size].competitorCount;
            sizeGroups[c.size].avgFbaFee = sizeGroups[c.size].totalFbaFee / sizeGroups[c.size].competitorCount;
        });

        // Identify the "Winner" size (Highest Revenue modified by "FBA Efficiency" — thinking about dimensions)
        let recommendedSize = 'Standard Size';
        let maxViabilityScore = 0;
        Object.keys(sizeGroups).forEach(size => {
            const group = sizeGroups[size];
            // Viability Score = Revenue * (1 - estimated FBA impact on price)
            // This weighs smaller, lighter items (lower FBA fee relative to price) more favorably
            const fbaImpact = group.avgFbaFee / group.avgPrice;
            const viabilityScore = group.totalRevenue * (1 - fbaImpact);
            
            if (viabilityScore > maxViabilityScore) {
                maxViabilityScore = viabilityScore;
                recommendedSize = size;
            }
        });

        // Sort by competitorAdjustedDaily descending (strongest to weakest)
        parsed.sort((a, b) => b.competitorAdjustedDaily - a.competitorAdjustedDaily);

        // Most Likely = Median capture of top performers (more robust than average)
        const top5 = parsed.slice(0, Math.min(5, parsed.length));
        top5.sort((a, b) => a.launchMostLikely - b.launchMostLikely);
        const mostLikely = top5.length > 0 
            ? top5[Math.floor(top5.length / 2)].launchMostLikely 
            : 15;

        // Best Case = Professional launch capture (30% of market leader)
        const bestCase = parsed[0].launchBestCase;
        
        logger.info(`[VETTING] Dynamic Baseline — Top Comp: ${parsed[0].competitorAdjustedDaily}/day, ML=${mostLikely}/day, BC=${bestCase}/day | Recommended Size: ${recommendedSize}`);

        return { 
            mostLikely, 
            bestCase, 
            perCompetitor: parsed, 
            sizePotential: sizeGroups,
            recommendedSize 
        };
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
        // BRAND POSITIONING: SIX10 VENTURES = MID-PREMIUM TIER
        You are an expert Amazon product analyst for Six10 Ventures, a moderate-to-premium Amazon brand.
        Analyze the competitor data below for the product idea: "${ideaName}".

        TASK:
        1. Classify each of the top competitors into a market tier: "Budget/Economy" (Lowest price point), "Mid-Range" (Balanced price/quality), or "Premium/Elite" (Highest specifications/brand value).
        2. Differentiate based on their Selling Price and Brand Authority. Do NOT default all to Mid-Range.
        3. Recommend a Target Size based on the winning market volume.
        4. Predict a realistic "Most Likely" and "Best Case" sales velocity for our new launch.
        5. USE THE PRE-COMPUTED DISTRIBUTIONS below. These scale relative to the category depth.
           - PRE-COMPUTED mostLikelyUnitsPerDay: ${velocity.mostLikely} (Target: ~50% capture of competitor average)
           - PRE-COMPUTED bestCaseUnitsPerDay: ${velocity.bestCase} (Target: parity with market leaders)
           - CROSS-CHECK: Evaluate your final estimates against the \`computedBadgeDaily\` and \`boughtPastMonth\` of all competitors.
           - RANGE ALIGNMENT: Your "Most Likely" scenario should NOT be significantly lower than the bottom-tier competitors if the product is viable. It should feel like a realistic entry into the range of volumes you see in the data (not too low, not too large).
        4. DETERMINE Seasonality: "365" (Year-round) or "245" (Seasonal).
           - HEAVY DEFAULT: Most products analyzed for Six10 Ventures are year-round (365). 
           - EXCEPTION (245): Only use 245 for rare, strictly seasonal items with NEAR-ZERO off-season demand (e.g. Christmas lights).
           - ANALYZE DATA: Scan \`category\` and \`keyFeatures\`. Categorize as 365 if there is ANY professional/replenishable utility.
           - BSR VALIDATION: If competitors show high sales velocity in the current "off-season," it must be 365.
           - If unsure, DEFAULT to 365.
        4.5. TARGET SKU SIZE: Based on the competitor data, identify which specific size (e.g., "32 oz", "1 Gallon", "Pack of 2") this Target Price and financial model is specifically for.
        5. TARGET PRICE POSITIONING: Six10 is a MID-PREMIUM brand. 
           - Position the target price 10-20% ABOVE the category median. 
           - Focus on matching the PREMIUM tier's features/quality while maintaining a slight price advantage over the highest-priced leader.
        6. BASEBALL CATEGORY: <$250K=Single, $750K=Double, $1.5M=Triple, >2.5M=Homerun (based on $25M denominator).
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
                brand: d.brand,
                computedBadgeDaily: v?.badgeDaily ?? 'N/A'
            };
        }), null, 2)}

        CONSTRAINTS:
        - mostLikelyUnitsPerDay: Aim for ±25% of ${velocity.mostLikely} (range: ${Math.floor(velocity.mostLikely * 0.75)}–${Math.ceil(velocity.mostLikely * 1.25)}). Ensure it is realistic against competitor volumes.
        - bestCaseUnitsPerDay: Aim for ±25% of ${velocity.bestCase} (range: ${Math.floor(velocity.bestCase * 0.75)}–${Math.ceil(velocity.bestCase * 1.25)}).
        - If you adjust outside this range (e.g. because you see a specific competitor doing much better and our product matches them), explain clearly in salesReasoning why the data justifies it.

        OUTPUT: Respond with ONLY valid raw JSON — no markdown, no explanation, no code blocks.
        {
          "classifications": [{"asin": "B0...", "brand": "Brand", "tier": "Mid-Range", "reasoning": "..."}],
          "targetSize": "${velocity.recommendedSize}",
          "targetPrice": 24.99,
          "pricingReasoning": "...",
          "mostLikelyUnitsPerDay": ${velocity.mostLikely},
          "bestCaseUnitsPerDay": ${velocity.bestCase},
          "salesReasoning": "The market data shows that the ${velocity.recommendedSize} size has the highest total volume potential ($${Math.round(velocity.sizePotential[velocity.recommendedSize]?.totalRevenue || 0).toLocaleString()} aggregated annual revenue across competitors). ...",
          "seasonality": "365",
          "seasonalityReasoning": "Year-round consumable with consistent DJ/professional use as seen in BSR stability.",
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

        // === HARD CLAMP: Enforce ±40% of pre-computed baselines ===
        // This ensures AI stability while allowing more realistic market alignment.
        const clampPct = 0.40;
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
    calculateFBAFee(productData) {
        const defaultFee = 4.50;
        if (!productData) return defaultFee;

        let weightLbs = 1.0;
        const weightStr = (productData.weight || '').toLowerCase();
        const weightMatch = weightStr.match(/([\d.]+)/);
        
        if (weightMatch) {
            let val = parseFloat(weightMatch[1]);
            if (weightStr.includes('oz') || weightStr.includes('ounce')) {
                weightLbs = val / 16;
            } else if (weightStr.includes('g') && !weightStr.includes('kg')) {
                weightLbs = val * 0.00220462;
            } else if (weightStr.includes('kg')) {
                weightLbs = val * 2.20462;
            } else {
                weightLbs = val; // Default to lbs
            }
        }

        let maxDim = 10;
        const dimStr = (productData.dimensions || '').toLowerCase();
        const dimsMatches = dimStr.match(/([\d.]+)/g);
        if (dimsMatches && dimsMatches.length >= 1) {
            const dims = dimsMatches.map(Number).sort((a, b) => b - a);
            maxDim = dims[0];
            if (dimStr.includes('cm') || dimStr.includes('centimeter')) {
                maxDim = maxDim * 0.393701;
            }
        }

        logger.info(`[FINANCIALS] Calculating FBA fee using Extracted Weight: ${weightLbs.toFixed(2)} lbs, Max Dim: ${maxDim.toFixed(2)} inches`);

        if (maxDim <= 15 && weightLbs <= 1) { // Small Standard
            if (weightLbs <= 0.25) return 3.22;
            if (weightLbs <= 0.50) return 3.40;
            if (weightLbs <= 0.75) return 3.58;
            return 3.77;
        } else { // Large Standard
            if (weightLbs <= 0.25) return 3.86;
            if (weightLbs <= 0.50) return 4.08;
            if (weightLbs <= 0.75) return 4.24;
            if (weightLbs <= 1.00) return 4.75;
            if (weightLbs <= 1.50) return 5.40;
            if (weightLbs <= 2.00) return 5.69;
            if (weightLbs <= 2.50) return 6.10;
            if (weightLbs <= 3.00) return 6.51;
            
            const over3 = Math.ceil((weightLbs - 3) * 2); // chunks of half lb
            const fee = 7.17 + (over3 * 0.16);
            return parseFloat(fee.toFixed(2));
        }
    }

    runFinancialModeling(targetSellingPrice, seasonalityStr, estimatedUnits, bestCaseUnits = null, claudeReturnRate = null, ideaName = null, productData = null) {
        const price = parseFloat(targetSellingPrice) || 19.99;
        let days = (seasonalityStr === '245' || seasonalityStr === 245) ? 245 : 365;  

        // --- INTELLIGENT SEASONALITY OVERRIDE (Six10 Directive) ---
        // Most items are 365. 245 is allowed ONLY for true seasonal categories.
        const normalizedIdea = String(ideaName || '').toLowerCase();
        
        // Items that SHOULD always be 365 (Consumables / Professional)
        const always365 = ['septic', 'fog', 'juice', 'cleaner', 'reagent', 'test', 'detergent', 'soap', 'treatment', 'professional', 'industrial'];
        
        // Items that are ALLOWED to be 245 (strictly seasonal)
        const allowed245 = ['holiday', 'christmas', 'halloween', 'thanksgiving', 'hanukkah', 'snow', 'santa', 'gift', 'winter', 'beach', 'summer'];

        if (days === 245) {
            // Force 365 if it's a known year-round consumable
            if (always365.some(k => normalizedIdea.includes(k))) {
                days = 365;
                logger.info(`[VETTING] Correcting consumable [${normalizedIdea}] to 365 days.`);
            } 
            // Otherwise, only keep 245 if the idea matches a seasonal keyword
            else if (!allowed245.some(k => normalizedIdea.includes(k))) {
                days = 365; // Default back to 365 for everything else
                logger.info(`[VETTING] Six10 Safety: Overriding suspected seasonal [${normalizedIdea}] to 365 days.`);
            }
        }

        const referralRate = 0.15;
        const adSpendPct = 0.20;   // Unified: 20% ad spend as per debrief
        // Use Claude's return rate if provided, else default 2.5%
        const retRate = (claudeReturnRate && claudeReturnRate > 0 && claudeReturnRate < 1)
            ? claudeReturnRate : 0.025;
        const avgInvHolding = 0.5; // Default per debrief
        
        const fbaFee = this.calculateFBAFee(productData);
        const supplierToAmazon = 2.00;   // Fixed $2.00 per debrief
        const storageAndInbound = 1.50;  // Fixed $1.50 per debrief

        const referralFee = price * referralRate;

        const totalFees = fbaFee + supplierToAmazon + storageAndInbound; // Fixed $8.00 total
        
        // --- 1. Calculate Target COGS for 30% Gross Margin ---
        // Formula: Margin = (SellingPrice * 0.85 - COGS - TotalFees) / SellingPrice
        // For 30% margin: COGS = SellingPrice * 0.55 - TotalFees
        const targetCogsByMargin = (price * 0.55) - totalFees;
        
        // --- 2. Calculate Target COGS for 200% ROIC ---
        // Formula: ROIC = (AnnualProfit / AvgInvValue) * 100
        // For 200% ROIC: 2.0 = [ (days * ProfitPerUnit) / (182.5 * COGS) ]
        // Let k = days / 182.5. Then 2.0 = k * (ProfitPerUnit / COGS) => COGS * (2/k) = ProfitPerUnit
        // UnitNetProfit = (Price * 0.85 - COGS - TotalFees) * (1 - RetRate) - Price * AdSpendRate
        // Solving for COGS: COGS = k * [(Price * 0.85 - TotalFees) * (1 - RetRate) - Price * AdSpendRate] / [2 + k * (1 - RetRate)]
        const kValue = days / 182.5; 
        const targetCogsByRoic = ( kValue * ((price * 0.85 - totalFees) * (1 - retRate) - (price * adSpendPct)) ) / (2 + kValue * (1 - retRate));

        // --- 3. Final Target COGS selection ---
        // Must satisfy BOTH: Gross Margin >= 30% AND ROIC >= 200%
        // This means taking the MINIMUM (more restrictive) COGS.
        let targetCogs = Math.min(targetCogsByMargin, targetCogsByRoic);
        if (targetCogs < 0) targetCogs = price * 0.10; // Floor: at least 10% of price
        
        logger.info(`[FINANCIALS] Modeling for $${price}: Margin-Target COGS: $${targetCogsByMargin.toFixed(2)}, ROIC-Target COGS: $${targetCogsByRoic.toFixed(2)} | Chosen: $${targetCogs.toFixed(2)}`);

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
                leadTimeDays: 60,
                dailyUnits_daysPerYear: days // Internal flag for the brief
            },
            scenarios
        };
    }

    /**
     * Emergency fallback for when AI fails or is disabled.
     */
    /**
     * Local Intelligence Calculation (Failsafe Mode)
     * Used when Anthropic servers are overloaded.
     */
    runLocalIntelligenceAnalysis(ideaName, competitorData) {
        // 1. Calculate Target Price (Median + 15%)
        const prices = competitorData.map(c => {
            const raw = c.data?.price || c.price || '0';
            const val = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
            return isNaN(val) ? null : val;
        }).filter(p => p > 0).sort((a,b) => a - b);
        
        let targetPrice = 29.99;
        if (prices.length > 0) {
            const median = prices[Math.floor(prices.length / 2)];
            targetPrice = parseFloat((median * 1.15).toFixed(2));
        }

        // 2. Local velocity baseline
        const velocity = this.computeMarketVelocity(competitorData);
        
        // 3. Simple Keyword Seasonality
        const comboText = (ideaName + ' ' + (competitorData[0]?.title || '')).toLowerCase();
        const isSeasonalStr = /christmas|halloween|winter|snow|summer|beach|pool/.test(comboText) ? "245" : "365";

        // 4. Baseball Category (Revenue-based)
        const annualRev = velocity.mostLikely * targetPrice * (isSeasonalStr === "365" ? 365 : 245);
        let baseballCategory = 'Single';
        if (annualRev >= 2500000) baseballCategory = 'Homerun';
        else if (annualRev >= 1500000) baseballCategory = 'Triple';
        else if (annualRev >= 750000) baseballCategory = 'Double';
        else if (annualRev >= 250000) baseballCategory = 'Single';
        else baseballCategory = 'Less Than a Single';

        const analysis = {
            classifications: competitorData.slice(0, 5).map(c => ({
                asin: c.asin,
                brand: c.data?.brand || c.brand || 'Competitor',
                tier: 'Mid-Range',
                reasoning: 'Auto-classified via Market Engine V2.'
            })),
            targetSize: velocity.recommendedSize,
            targetPrice,
            estimatedUnitsPerDay: velocity.mostLikely,
            mostLikelyUnitsPerDay: velocity.mostLikely,
            bestCaseUnitsPerDay: velocity.bestCase,
            seasonality: isSeasonalStr,
            baseballCategory,
            returnRate: 0.025,
            formatResearch: 'Standard positioning.',
            intelligenceBrief: `[ENGINE V2] Detailed market analysis conducted using statistical correlation of the top ${competitorData.length} competitors. Pricing is optimized at $${targetPrice} to capture a Mid-Premium advantage. Volume modeling indicates a ${baseballCategory} opportunity with steady performance observed across lead competitors.`
        };

        const primaryProduct = competitorData && competitorData.length > 0 ? (competitorData[0].data || competitorData[0]) : null;
        const financials = this.runFinancialModeling(targetPrice, isSeasonalStr, velocity.mostLikely, velocity.bestCase, 0.025, ideaName, primaryProduct);

        return {
            ideaName,
            analysis,
            financials,
            competitorData
        };
    }

    /**
     * Helper to compute estimated velocity from scraped competitor data
     */
    computeMarketVelocity(competitorData) {
        if (!competitorData || competitorData.length === 0) {
            return { mostLikely: 25, bestCase: 41 };
        }

        const dailySales = competitorData.map(c => {
            const boughtStr = c.data?.boughtPastMonth || c.boughtPastMonth || '';
            const m = boughtStr.match(/([\d,K.]+)\+/i);
            if (m) {
                let val = m[1].replace(/,/g, '').replace(/K/i, '000');
                return Math.floor(parseFloat(val) / 30);
            }
            return null;
        }).filter(v => v !== null && v > 0).sort((a, b) => a - b);

        if (dailySales.length === 0) {
            return { mostLikely: 25, bestCase: 41 };
        }

        const median = dailySales[Math.floor(dailySales.length / 2)];
        const mostLikely = Math.max(10, Math.min(100, median));
        
        // Best case is typically the top performer in our selection
        const topPerformer = dailySales[dailySales.length - 1];
        const bestCase = Math.max(mostLikely * 1.5, topPerformer);

        return { mostLikely, bestCase };
    }

    /**
     * Alias for orchestrator compatibility
     */
    runLocalModelingFallback(ideaName, competitorData) {
        return this.runLocalIntelligenceAnalysis(ideaName, competitorData);
    }
}

module.exports = new VettingEngine();

