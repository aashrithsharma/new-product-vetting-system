const logger = require('./logger');
const config = require('./config');
const cheerio = require('cheerio');
const axios = require('axios');

function cleanText(str) {
    if (!str || str === 'N/A') return str;
    return str
        .replace(/[\u200e\u200f\u200b\u200c\u200d\u00ad\ufeff\u2022\u2605\u2b50]/g, '') // Added star icons to clean
        .replace(/\s+/g, ' ')
        .trim();
}

class ScraperEngine {
    constructor() {}

    async init() {}
    async close() {}

    async getPriceFromScraperAPI(asin) {
        let attempts = 0;
        const maxAttempts = 3;
        const apiKey = process.env.SCRAPERAPI_KEY;
        if (!apiKey) return null;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${apiKey}&asin=${asin}&country=us`;
                const res = await axios.get(url, { timeout: 45000, headers: { 'Accept': 'application/json' }});
                if (res.status === 200) {
                    const data = res.data;
                    logger.info(`[${asin}] ScraperAPI-Structured JSON retrieved successfully.`);
                    return data; // Return full structured object
                }
                return null;
            } catch (e) {
                const isRetryable = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || (e.response && e.response.status >= 500);
                if (isRetryable && attempts < maxAttempts) {
                    const delay = Math.pow(2, attempts) * 1000;
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                return null;
            }
        }
    }

    async getHTMLFromScraperAPI(asin, domain, render = false) {
        let attempts = 0;
        const maxAttempts = 3;
        const apiKey = process.env.SCRAPERAPI_KEY;
        const targetUrl = `https://${domain}/dp/${asin}?th=1&psc=1&language=en_US&currency=USD&gl=US`;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                let url;
                if (apiKey) {
                    url = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
                    if (render) url += '&render=true';
                } else {
                    url = targetUrl;
                }
                const res = await axios.get(url, { 
                    timeout: render ? 90000 : 45000,
                    headers: apiKey ? {} : {
                        'User-Agent': config.scraper.userAgentPool[0] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                if (res.status === 200) {
                    return res.data;
                }
            } catch (e) {
                logger.warn(`[${asin}] Error fetching HTML (render=${render}): ${e.message}`);
                if (attempts < maxAttempts) {
                    const delay = Math.pow(2, attempts) * 1000;
                    await new Promise(r => setTimeout(r, delay));
                }
                continue;
            }
        }
        return null;
    }

    async scrapeASIN(product, progressCallback) {
        const { asin, domain } = typeof product === 'string' ? { asin: product, domain: config.scraper.defaultDomain } : product;
        logger.info(`[SCRAPER] Scraping ${asin} on ${domain}`);

        const apiPricePromise = this.getPriceFromScraperAPI(asin);
        const htmlPromise = this.getHTMLFromScraperAPI(asin, domain);

        const [structuredData, html] = await Promise.all([apiPricePromise, htmlPromise]);

        if (!html && !structuredData) {
            return { asin, status: 'FAILED', reason: 'Failed to retrieve page HTML and JSON' };
        }

        let data = {
            asin, title: 'N/A', brand: 'N/A', price: 'N/A', reviews: 'N/A',
            stars: 'N/A', bsr: 'N/A', form: 'N/A', size: 'N/A', imageUrl: '',
            boughtPastMonth: 'N/A', dimensions: 'N/A', weight: 'N/A', 
            bulletPoints: '', description: '', category: 'N/A',
            timestamp: new Date().toISOString()
        };

        if (html) {
            data = this.extractWithCheerio(html, asin, structuredData);
        } else if (structuredData) {
            // FALLBACK TO JSON IF HTML FAILS
            logger.info(`[${asin}] HTML fetch failed, fallback to structured JSON.`);
            data.title = structuredData.name || structuredData.title || structuredData.product_name || 'N/A';
            data.brand = structuredData.brand || 'N/A';
            data.price = structuredData.pricing || structuredData.price || 'N/A';

            // Reviews: try top-level, then nested customer_reviews
            const reviewsCount = structuredData.total_reviews
                || structuredData.total_ratings
                || structuredData.product_information?.customer_reviews?.ratings_count
                || null;
            data.reviews = reviewsCount ? String(reviewsCount) : 'N/A';

            // Stars/Rating: try average_rating, stars, then nested customer_reviews
            const starsVal = structuredData.average_rating
                || structuredData.stars
                || structuredData.product_information?.customer_reviews?.stars
                || null;
            data.stars = starsVal ? String(starsVal) : 'N/A';

            data.imageUrl = (structuredData.images && (structuredData.images[0]?.url || structuredData.images[0])) || '';
            // Basic bullet points
            if (structuredData.feature_bullets) data.bulletPoints = structuredData.feature_bullets.join(' | ');
            if (structuredData.full_description) data.description = structuredData.full_description;
            if (structuredData.categories) data.category = structuredData.categories.map(c=>c.name).join(' > ');
            if (structuredData.product_category) data.category = structuredData.product_category;

            // Best effort product information
            if (structuredData.product_information) {
                const info = structuredData.product_information;
                // Package dimensions field often contains "L x W x H; WeightUnit" — split them
                const pkgDimStr = info.package_dimensions || info.item_dimensions || '';
                if (pkgDimStr) {
                    // Dimensions: e.g. "8.03 x 6.57 x 0.75 inches"
                    const mDim = pkgDimStr.match(/([\d.]+\s*x\s*[\d.]+\s*x\s*[\d.]+\s*(?:inches|in|cm|mm))/i);
                    if (mDim) data.dimensions = mDim[1];
                    // Weight often after semicolon: "8.03 x 6.57 x 0.75 inches; 11.85 ounces"
                    const mWeight = pkgDimStr.match(/;\s*([\d.]+\s*(?:ounces|oz|pounds|lbs|grams|g|kg))/i)
                        || pkgDimStr.match(/([\d.]+\s*(?:ounces|oz|pounds|lbs|grams|g|kg))/i);
                    if (mWeight) data.weight = mWeight[1].trim();
                }
                // Fallback: item_weight field
                if (data.weight === 'N/A' && info.item_weight) data.weight = info.item_weight;

                const bsrRaw = info.best_sellers_rank;
                if (bsrRaw) {
                    const bsrStr = Array.isArray(bsrRaw) ? bsrRaw.join(' ') : String(bsrRaw);
                    const mBsr = bsrStr.match(/#([\d,]+)/);
                    if (mBsr) data.bsr = mBsr[1].replace(/,/g, '');
                }
            }
            if (structuredData.sales_volume) data.boughtPastMonth = structuredData.sales_volume;
        }

        // Quality Check & Robust Fallback (Layer 3: Browser Rendering)
        // If critical data (BSR, Rating, Dimensions, Weight) is still N/A, we try a rendered fetch
        const isDataMissing = (data.bsr === 'N/A' || data.stars === 'N/A' || data.dimensions === 'N/A' || data.weight === 'N/A');
        const isRenderRun = (typeof product === 'object' && product.render === true);
        const canRetryRender = process.env.SCRAPERAPI_KEY && !isRenderRun; // Prevent infinite loop

        if (isDataMissing && canRetryRender) {
            logger.info(`[${asin}] Critical data missing (BSR/Rating/Dim), retrying with Javascript rendering...`);
            const renderHtml = await this.getHTMLFromScraperAPI(asin, domain, true); // Use render=true
            if (renderHtml) {
                const renderData = this.extractWithCheerio(renderHtml, asin, structuredData);
                // Merge data, prioritizing renderData over initial data if renderData is not N/A
                const keysToMerge = ['bsr', 'stars', 'reviews', 'boughtPastMonth', 'dimensions', 'weight', 'category'];
                keysToMerge.forEach(key => {
                    if (renderData[key] !== 'N/A' && renderData[key] !== '') {
                        data[key] = renderData[key];
                    }
                });
                logger.info(`[${asin}] Render retry complete. Quality: ${ (data.bsr!=='N/A'?'BSR✓ ':'') + (data.stars!=='N/A'?'Stars✓ ':'') + (data.dimensions!=='N/A'?'Dim✓ ':'') }`);
            }
        }

        if (data.title === 'N/A' || data.title === '') {
            return { asin, status: 'NO_PRODUCT', reason: 'Page loaded but no product details found' };
        }

        return { asin, status: 'SUCCESS', data };
    }

    extractWithCheerio(html, asin, structuredData = null) {
        const $ = cheerio.load(html);

        const results = {
            asin, title: 'N/A', brand: 'N/A', price: 'N/A', reviews: 'N/A',
            stars: 'N/A', bsr: 'N/A', form: 'N/A', size: 'N/A', imageUrl: '',
            boughtPastMonth: 'N/A', dimensions: 'N/A', weight: 'N/A', 
            bulletPoints: '', description: '', category: 'N/A',
            timestamp: new Date().toISOString()
        };

        const details = {};
        const cleanKey = (k) => k.toLowerCase().replace(/[:\u2022\u200b]/g, '').trim();

        $('#productDetails_techSpec_section_1 tr, #table_productDetails_db_sections tr, .a-expander-content table tr').each((i, el) => {
            const th = $(el).find('th').text().trim();
            const td = $(el).find('td').text().trim();
            if (th && td) details[cleanKey(th)] = cleanText(td);
        });

        $('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li').each((i, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (text.includes(':')) {
                const parts = text.split(':');
                details[cleanKey(parts[0])] = cleanText(parts.slice(1).join(':'));
            }
        });

        const imageSelectors = ['#landingImage', '#imgBlkFront', '.a-dynamic-image', '#main-image'];
        for (const sel of imageSelectors) {
            const el = $(sel);
            if (el.length) {
                let url = el.attr('data-old-hires') || el.attr('src');
                if (url && url.startsWith('https://')) {
                    results.imageUrl = url;
                    break;
                }
            }
        }

        results.title = cleanText($('#productTitle').text() || $('#title').text() || 'N/A');

        const brandKeys = ['brand', 'brand name', 'manufacturer', 'sold by'];
        for (const k of brandKeys) { if (details[k]) { results.brand = cleanText(details[k]); break; } }
        if (results.brand === 'N/A') {
            const rawBrand = $('#bylineInfo').text();
            results.brand = cleanText(rawBrand.replace(/Visit the\s+/i, '').replace(/\s+Store/i, '').replace(/Brand:\s+/i, '').replace(/^by\s+/i, ''));
        }

        const apiPrice = structuredData?.pricing || structuredData?.price;
        if (apiPrice && apiPrice.toString().includes('$')) {
            results.price = apiPrice;
            logger.info(`[${asin}] Using ScraperAPI price: ${apiPrice}`);
        } else if (apiPrice && !isNaN(parseFloat(apiPrice))) {
            results.price = '$' + apiPrice;
            logger.info(`[${asin}] Using formatted ScraperAPI price: ${results.price}`);
        } else {
            results.price = 'N/A';
        }

        if (results.price === 'N/A') {
            const alSelectors = [
                '#apex-pricetopay-accessibility-label', 
                'span.apex-pricetopay-value .a-offscreen', 
                '#priceblock_ourprice', 
                '#priceblock_dealprice', 
                '.a-price .a-offscreen',
                '.aok-offscreen', 
                '.a-offscreen',
                '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
                '#corePrice_desktop .a-price .a-offscreen',
                '#price_inside_buybox',
                '.kindle-price',
                '#price'
            ];
            for (const sel of alSelectors) {
                $(sel).each((i, el) => {
                    if (results.price !== 'N/A') return false;
                    const txt = $(el).text().trim();
                    const m = txt.match(/([$][\d,]+\.?\d*)/i);
                    if (m && m[0] && m[0] !== '$0') {
                        results.price = m[0];
                    }
                });
                if (results.price !== 'N/A') break;
            }
        }

        if (results.price === 'N/A') {
            const hiddenInput = $('input[name*="customerVisiblePrice"][name*="displayString"]').first();
            if (!hiddenInput.length) {
                $('input[id*="customerVisiblePrice"]').each((i, el) => {
                    if (results.price === 'N/A') {
                        const val = $(el).attr('value') || '';
                        if (val && val.length > 0 && val !== '0' && val.includes('$')) results.price = cleanText(val);
                    }
                });
            } else {
                const val = hiddenInput.attr('value') || '';
                if (val && val.length > 0 && val !== '0' && val.includes('$')) results.price = cleanText(val);
            }
        }

        if (results.price === 'N/A') {
            const whole = $('.a-price-whole').first().text().replace(/[^0-9.]/g, '').replace(/\.$/, '');
            const fraction = $('.a-price-fraction').first().text().replace(/[^0-9]/g, '');
            if (whole) {
                results.price = '$' + whole + (fraction ? '.' + fraction : '');
            }
        }

        // BSR Extraction - Targeted Keys
        const bsrKeys = ['best sellers rank', 'sellers rank', 'amazon best sellers rank', 'rank'];
        for (const k of bsrKeys) {
            if (details[k]) {
                const m = details[k].match(/#([\d,]+)/);
                if (m) {
                    results.bsr = m[1].replace(/,/g, '');
                    break;
                }
            }
        }
        
        // Fallback for BSR if not in 'details' object - Text Scanning
        if (results.bsr === 'N/A') {
            const fullText = $('body').text().replace(/\s+/g, ' ');
            const bsrMatch = fullText.match(/Best Sellers Rank[:\s]+#?\s*([\d,]+)/i) || 
                             fullText.match(/Sellers Rank[:\s]+#?\s*([\d,]+)/i);
            if (bsrMatch && bsrMatch[1]) {
                results.bsr = bsrMatch[1].replace(/,/g, '');
            }
        }
        
        // Deep Fallback: Use Structured JSON BSR
        if (results.bsr === 'N/A' && structuredData?.product_information?.best_sellers_rank) {
            const bsrRaw = structuredData.product_information.best_sellers_rank;
            const bsrStr = Array.isArray(bsrRaw) ? bsrRaw.join(' ') : String(bsrRaw);
            const mBsr = bsrStr.match(/#([\d,]+)/);
            if (mBsr) {
                results.bsr = mBsr[1].replace(/,/g, '');
            }
        }
        
        const starSelectors = [
            '#acrPopover', 
            '.a-icon-star', 
            'span[data-hook="rating-out-of-text"]', 
            '#averageCustomerReviews a > span',
            '.a-star-5, .a-star-45, .a-star-4, .a-star-35, .a-star-3',
            'i.a-icon-star-small',
            'span.a-icon-alt'
        ];
        
        let starText = '';
        for (const sel of starSelectors) {
            const el = $(sel);
            if (el.length) {
                const t = el.attr('title') || el.text() || '';
                if (t.match(/\d+\.?\d*/)) {
                    starText = t;
                    break;
                }
            }
        }
        
        const starMatch = starText ? starText.match(/(\d+\.?\d*)\s*out of/i) || starText.match(/(\d+\.?\d*)/) : null;
        if (starMatch && parseFloat(starMatch[1]) <= 5) {
            results.stars = cleanText(starMatch[1]);
        } else {
            // Fallback to structured JSON — try all known field names
            const starsVal = structuredData?.average_rating
                || structuredData?.stars
                || structuredData?.product_information?.customer_reviews?.stars
                || null;
            if (starsVal) results.stars = String(starsVal);
        }

        // Use specific selectors for review COUNT only (not the star rating span)
        const revEl = $('#acrCustomerReviewText, span[data-hook="total-review-count"]').first();
        if (revEl.length) {
            const revMatch = cleanText(revEl.text()).match(/(\d[\d,]*)/);
            if (revMatch) {
                const num = parseInt(revMatch[1].replace(/,/g, ''), 10);
                // Must be >9 to avoid accidentally catching a star rating digit
                if (num > 9) results.reviews = String(num);
            }
        }
        if (results.reviews === 'N/A') {
            // Try all known structured data locations for review count
            const revCount = structuredData?.total_reviews
                || structuredData?.total_ratings
                || structuredData?.product_information?.customer_reviews?.ratings_count
                || null;
            if (revCount) results.reviews = String(revCount);
        }
        // Last effort: scan for "ratings" or "reviews" nearby numbers
        if (results.reviews === 'N/A') {
            const reviewsM = $('body').text().match(/([\d,]+)\s*(?:global ratings|customer reviews|total reviews)/i);
            if (reviewsM) results.reviews = reviewsM[1].replace(/,/g, '');
        }

        const formKeys = ['item form', 'form', 'format'];
        for (const k of formKeys) { if (details[k]) { results.form = cleanText(details[k]); break; } }

        const combinedText = (results.title + ' ' + $('body').text()).toLowerCase();
        const sizeMatch = combinedText.match(/(\d+\.?\d*\s?(lbs?|oz|lb|kg|g|fl\s?oz|count|ct))/i);
        if (sizeMatch) results.size = cleanText(sizeMatch[0]);

        // PROJECT 2 EXTENSIONS: Dimensions, Weight
        // PROJECT 2 EXTENSIONS: Dimensions, Weight
        const dimKeys = ['product dimensions', 'item dimensions lxwxh', 'package dimensions', 'dimensions', 'size', 'item dimensions'];
        for (const k of dimKeys) { if (details[k]) { results.dimensions = cleanText(details[k]); break; } }
        
        // Aggressive table lookup for dimensions if still N/A
        if (results.dimensions === 'N/A' || results.dimensions === '-') {
            $('.a-keyvalue tr, .prodDetTable tr, #technicalSpecifications_section_1 tr').each((i, el) => {
                const label = $(el).find('th, td:first-child').text().toLowerCase();
                const value = $(el).find('td').last().text().trim();
                // Match "dimensions", "size", or "lxwxh"
                if (label.includes('dimensions') || label.includes('size') || label.includes('lxwxh')) {
                    results.dimensions = cleanText(value);
                    return false;
                }
            });
        }
        
        const weightKeys = ['item weight', 'package weight', 'weight', 'shipping weight'];
        for (const k of weightKeys) { if (details[k]) { results.weight = cleanText(details[k]); break; } }
        
        if (results.dimensions === 'N/A' || results.dimensions === '-') {
            // Try multiple structured data fields for dimensions
            const dimVal = structuredData?.product_information?.dimensions
                || structuredData?.product_information?.item_dimensions;
            if (dimVal) results.dimensions = cleanText(dimVal);
            // Also try parsing from package_dimensions string
            if ((results.dimensions === 'N/A' || results.dimensions === '-') && structuredData?.product_information?.package_dimensions) {
                const pkgStr = structuredData.product_information.package_dimensions;
                const mDim = pkgStr.match(/([\d.]+\s*[x×*]\s*[\d.]+\s*[x×*]\s*[\d.]+\s*(?:inches|in|cm|mm))/i);
                if (mDim) results.dimensions = cleanText(mDim[1]);
            }
        }
        if (results.weight === 'N/A') {
            // Try structured item_weight, then parse from package_dimensions string
            const weightVal = structuredData?.product_information?.weight
                || structuredData?.product_information?.item_weight;
            if (weightVal) results.weight = cleanText(weightVal);
            if (results.weight === 'N/A' && structuredData?.product_information?.package_dimensions) {
                const pkgStr = structuredData.product_information.package_dimensions;
                // Require actual digit(s) before unit; avoid matching ".g" or ".oz"
                const mW = pkgStr.match(/;\s*(\d+\.?\d*\s*(?:ounces|oz|pounds|lbs|grams|kg))/i)
                    || pkgStr.match(/(\d+\.?\d*\s*(?:ounces|oz|pounds|lbs|grams|kg))/i);
                if (mW) results.weight = cleanText(mW[1].trim());
            }
        }

        const fullBodyText = $('body').text().replace(/\s+/g, ' ');

        if (results.weight === 'N/A') {
            const weightKeys = ['item weight', 'package weight', 'weight', 'shipping weight'];
            $('.a-keyvalue tr, .prodDetTable tr').each((i, el) => {
                const label = $(el).find('th, td:first-child').text().toLowerCase();
                const value = $(el).find('td').last().text().trim();
                if (weightKeys.some(k => label.includes(k))) {
                    results.weight = cleanText(value);
                    return false;
                }
            });
        }

        // Deep Brute-Force Fallback for Weight/Dimensions from body text
        if (results.dimensions === 'N/A' || results.dimensions === '-') {
            // Regex for 12 x 10 x 5 inches, support cross-product sign and different units
            const dimRegex = /([\d.]+\s*(?:["']|inches|in|cm|mm|l|w|h)?\s*[x×*]\s*[\d.]+\s*(?:["']|inches|in|cm|mm|l|w|h)?\s*[x×*]\s*[\d.]+\s*(?:["']|inches|in|cm|mm|l|w|h)?)/i;
            const dimM = fullBodyText.match(dimRegex);
            if (dimM) results.dimensions = cleanText(dimM[1]);
        }
        
        if (results.weight === 'N/A') {
            // Brute force weight - Avoid single 'g' or 'G' as it hits model numbers like "51G"
            // Use longer units for body-wide brute force
            const weightRegex = /\b(\d+\.?\d*\s*(?:pounds|lbs|ounces|oz|grams|kg|pounds|lb))\b/i;
            const weightM = fullBodyText.match(weightRegex);
            if (weightM) results.weight = cleanText(weightM[1]);
        }

        // PROJECT 2 EXTENSIONS: "Bought in past month" Badge
        const boughtSelectors = [
            '#social-proofing-faceout-title-tk_bought',
            '#social-proofing-faceout-title-tk_bought_1_faceout',
            '.social-proofing-faceout-title-text',
            '#social-proofing-faceout-title-tk_bought span'
        ];
        
        let boughtTextRaw = '';
        for (const sel of boughtSelectors) {
            const txt = $(sel).text().trim();
            if (txt && txt.toLowerCase().includes('bought')) {
                boughtTextRaw = txt;
                break;
            }
        }
        
        // Regex to find "50+ bought in past month", "1K+ bought in past month", etc.
        const boughtM = (boughtTextRaw || fullBodyText).match(/([\d,K.]+)\s*(?:\+|plus)?\s*(?:bought|viewed)\s*in\s*past\s*month/i);
        
        if (boughtM && boughtM[1]) {
            results.boughtPastMonth = cleanText(boughtM[1].replace('+', '') + '+ bought in past month');
        } else if (boughtTextRaw) {
            results.boughtPastMonth = cleanText(boughtTextRaw);
        }
        
        // Fallback for boughtPastMonth from structured data
        if (results.boughtPastMonth === 'N/A' && structuredData?.sales_volume) {
            results.boughtPastMonth = String(structuredData.sales_volume);
        }


        // PROJECT 2 EXTENSIONS: Bullet points & description
        const bullets = [];
        $('#feature-bullets li span.a-list-item').each((i, el) => {
            const b = cleanText($(el).text());
            if (b && !b.toLowerCase().includes('make sure this fits')) bullets.push(b);
        });
        results.bulletPoints = bullets.join(' | ');
        results.description = cleanText($('#productDescription').text() || '');

        // NEW: Extract Product Category (Breadcrumbs)
        const breadcrumbs = [];
        $('#wayfinding-breadcrumbs_container ul li span.a-list-item, #wayfinding-breadcrumbs_feature_div ul li span.a-list-item, .a-breadcrumb .a-list-item').each((i, el) => {
            const bText = cleanText($(el).text());
            if (bText && bText !== '›') { // Exclude separator characters if parsed
                breadcrumbs.push(bText);
            }
        });
        if (breadcrumbs.length > 0) {
            results.category = breadcrumbs.join(' > ');
        }


        for (const key in results) {
            if (typeof results[key] === 'string') results[key] = cleanText(results[key]);
        }

        return results;
    }
}

module.exports = new ScraperEngine();
