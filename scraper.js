const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const logger = require('./logger');
const config = require('./config');
const { delay } = require('./utils');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

chromium.use(stealth);

function cleanText(str) {
    if (!str || str === 'N/A') return str;
    // Remove ALL non-printable and special invisible characters
    return str
        .replace(/[\u200e\u200f\u200b\u200c\u200d\u00ad\ufeff\u2022]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function convertToUSD(priceStr) {
    if (!priceStr || priceStr === 'N/A') return priceStr;

    const clean = priceStr.replace(/[\u200e\u200f\u200b\u200c\u200d]/g, '').trim();

    // Already USD — return as-is
    if (clean.startsWith('$')) return clean;

    // Strip INR symbol / text, remove commas
    const numStr = clean
        .replace(/INR/gi, '')
        .replace(/₹/g, '')
        .replace(/,/g, '')
        .trim();

    const inrValue = parseFloat(numStr);
    if (isNaN(inrValue) || inrValue <= 0) return priceStr; // unparseable — pass through

    const rate = global.exchangeRate && global.exchangeRate > 0 ? global.exchangeRate : 90; // Fallback if API fails
    const usd = inrValue / rate;

    const formatted = '$' + usd.toFixed(2);
    logger.info(`[PRICE-CONV] ₹${inrValue.toFixed(2)} ÷ ${rate} = ${formatted}`);
    return formatted;
}

async function extractUSDFromPageJSON(page, asin) {
    // Amazon embeds real USD prices in JSON inside <script> tags.
    // This works even when the displayed price is in INR.
    try {
        const result = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script[type="text/javascript"], script:not([src])'));
            const log = [];

            for (const script of scripts) {
                const text = script.textContent || '';

                // Method J1: Look for twister (variants) JSON — "price":"19.99" or "priceAmount":19.99
                const priceAmountMatch = text.match(/"priceAmount"\s*:\s*([\d.]+)/);
                if (priceAmountMatch) {
                    log.push(`J1-priceAmount: ${priceAmountMatch[1]}`);
                    return { price: '$' + parseFloat(priceAmountMatch[1]).toFixed(2), method: 'J1-priceAmount', log };
                }

                // Method J2: buyingPrice field in JSON
                const buyingMatch = text.match(/"buyingPrice"\s*:\s*([\d.]+)/);
                if (buyingMatch) {
                    log.push(`J2-buyingPrice: ${buyingMatch[1]}`);
                    return { price: '$' + parseFloat(buyingMatch[1]).toFixed(2), method: 'J2-buyingPrice', log };
                }

                // Method J3: displayPrice field containing $ sign
                const displayMatch = text.match(/"displayPrice"\s*:\s*"\$([ \d.,]+)"/);
                if (displayMatch) {
                    const num = displayMatch[1].replace(/,/g, '').trim();
                    log.push(`J3-displayPrice: $${num}`);
                    return { price: '$' + parseFloat(num).toFixed(2), method: 'J3-displayPrice', log };
                }

                // Method J4: "price":"$XX.XX" pattern in JSON
                const priceFieldMatch = text.match(/"price"\s*:\s*"\$([ \d.,]+)"/);
                if (priceFieldMatch) {
                    const num = priceFieldMatch[1].replace(/,/g, '').trim();
                    log.push(`J4-price field: $${num}`);
                    return { price: '$' + parseFloat(num).toFixed(2), method: 'J4-price-field', log };
                }
            }

            // Method J5: Check og:price:amount meta tag
            const ogPrice = document.querySelector('meta[property="og:price:amount"]');
            const ogCurrency = document.querySelector('meta[property="og:price:currency"]');
            if (ogPrice && ogCurrency && ogCurrency.getAttribute('content') === 'USD') {
                const val = ogPrice.getAttribute('content');
                log.push(`J5-og:price:amount: $${val}`);
                return { price: '$' + parseFloat(val).toFixed(2), method: 'J5-og-meta', log };
            }

            return { price: null, method: 'JSON-NONE', log };
        });

        for (const line of (result.log || [])) {
            logger.info(`[${asin}] [JSON-PRICE]   ${line}`);
        }
        if (result.price) {
            logger.info(`[${asin}] [JSON-PRICE] ✔ Found real USD via ${result.method}: ${result.price}`);
        } else {
            logger.info(`[${asin}] [JSON-PRICE] No USD price found in page JSON/meta`);
        }
        return result.price;
    } catch (err) {
        logger.warn(`[${asin}] [JSON-PRICE] Error: ${err.message}`);
        return null;
    }
}

async function getAmazonPrice(page) {
    const asin = await page.evaluate(() => {
        const el = document.querySelector('#ASIN') || document.querySelector('[name="asin"]');
        return el ? el.value : 'unknown';
    }).catch(() => 'unknown');

    const priceSelectors = [
        '#corePriceDisplay_desktop_feature_div',
        '#apex_offerDisplay_desktop',
        '#corePrice_feature_div',
        '#buyNewSection',
        '#price_inside_buybox'
    ];

    // --- LOG: Which price containers exist in DOM before waiting ---
    const containerPresence = await page.evaluate((selectors) => {
        return selectors.map(sel => ({ sel, found: !!document.querySelector(sel) }));
    }, priceSelectors).catch(() => []);
    logger.info(`[${asin}] [PRICE] Container presence check:`);
    for (const { sel, found } of containerPresence) {
        logger.info(`[${asin}] [PRICE]   ${found ? '✔' : '✘'} ${sel}`);
    }

    // --- LOG: All .a-offscreen values before waiting ---
    const offscreenBefore = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.a-offscreen, .aok-offscreen')).map(el => el.textContent.trim())
    ).catch(() => []);
    logger.info(`[${asin}] [PRICE] offscreen values BEFORE wait (${offscreenBefore.length} found): ${JSON.stringify(offscreenBefore.slice(0, 10))}`);

    // Wait for price — checks the exact DevTools selector first, then falls back
    let waitResult = 'resolved';
    try {
        await page.waitForFunction(() => {
            // Method 0: Exact selector confirmed from DevTools
            const exactEl = document.querySelector(
                '#corePrice_feature_div span.apex-pricetopay-value span.a-offscreen, ' +
                '#corePriceDisplay_desktop_feature_div span.apex-pricetopay-value span.a-offscreen, ' +
                '#apex-pricetopay-accessibility-label, ' +
                '.aok-offscreen'
            );
            if (exactEl) {
                const txt = exactEl.textContent.trim();
                if (txt.length > 0 && txt !== '$0' && txt !== '$0.00' && txt !== '₹0' && txt !== '₹0.00') return true;
            }
            // Fallback: generic search across known containers
            const selectors = [
                '#corePriceDisplay_desktop_feature_div',
                '#apex_offerDisplay_desktop',
                '#corePrice_feature_div',
                '#buyNewSection',
                '#price_inside_buybox'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (!el) continue;
                const off = el.querySelector('.a-offscreen');
                if (off) {
                    const txt = off.textContent.trim();
                    if (
                        txt.length > 0 &&
                        txt !== '$0' && txt !== '$0.00' &&
                        txt !== '₹0' && txt !== '₹0.00' &&
                        (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))
                    ) return true;
                }
            }
            const all = document.querySelectorAll('.a-offscreen, .aok-offscreen');
            for (const el of all) {
                const txt = el.textContent.trim();
                if (
                    txt.length > 0 &&
                    txt !== '$0' && txt !== '$0.00' &&
                    txt !== '₹0' && txt !== '₹0.00' &&
                    (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))
                ) return true;
            }
            return false;
        }, { timeout: 20000 });
        logger.info(`[${asin}] [PRICE] waitForFunction → resolved (price element found in DOM)`);
    } catch (e) {
        waitResult = 'timed_out';
        logger.warn(`[${asin}] [PRICE] waitForFunction → TIMED OUT (no valid price element appeared in 20s)`);
    }

    // --- LOG: All .a-offscreen values AFTER waiting ---
    const offscreenAfter = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.a-offscreen, .aok-offscreen')).map(el => el.textContent.trim())
    ).catch(() => []);
    logger.info(`[${asin}] [PRICE] offscreen values AFTER wait (${offscreenAfter.length} found): ${JSON.stringify(offscreenAfter.slice(0, 10))}`);

    // Read price from live DOM with per-method logging
    const domResult = await page.evaluate((selectors) => {
        const log = [];

        // Method AL: Accessibility Labels (User suggested) - id="apex-pricetopay-accessibility-label"
        // Move to TOP because user requested to "always check the pricetopay"
        const accessibilitySelectors = [
            '#apex-pricetopay-accessibility-label',
            'span.apex-pricetopay-value span.a-offscreen',
            '#corePrice_desktop .a-price span.a-offscreen',
            '#corePriceDisplay_desktop_feature_div .a-price span.a-offscreen',
            '.aok-offscreen',
            '.a-offscreen'
        ];
        for (const sel of accessibilitySelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                // Skip if hidden or inside irrelevant sections (like reviews)
                if (el.closest('#customer_review-section, #reviews-medley-footer, #HLCXComparisonTable')) continue;

                // Check data attributes first (often cleaner)
                const dataPrice = el.getAttribute('data-pricetopay-label') || el.getAttribute('data-pricetopay-savings-label');
                // Ensure it's not a placeholder like "{priceToPay}"
                if (dataPrice && !dataPrice.includes('{') && (dataPrice.includes('$') || dataPrice.includes('₹') || dataPrice.toUpperCase().includes('INR'))) {
                    // FILTER: If on .com, only accept $
                    if (window.location.hostname.includes('amazon.com') && !dataPrice.includes('$')) continue;
                    
                    const m = dataPrice.match(/([$₹][\d,]+\.?\d*|INR\s?[\d,]+\.?\d*)/i);
                    if (m) {
                        log.push(`[AL-ATTR] ${sel}: "${m[0]}" from data-pricetopay-label`);
                        return { price: m[0], method: 'AL-ACCESS-LABEL-ATTR', sel, log };
                    }
                }

                const txt = el.textContent.trim();
                if (txt && txt !== '$0' && txt !== '$0.00' && txt !== '₹0' && txt !== '₹0.00') {
                    // FILTER: If on .com, only accept $
                    if (window.location.hostname.includes('amazon.com') && !txt.includes('$')) continue;

                    const m = txt.match(/([$₹][\d,]+\.?\d*|INR\s?[\d,]+\.?\d*)/i);
                    if (m) {
                        log.push(`[AL] ${sel}: "${m[0]}"`);
                        return { price: m[0], method: 'AL-ACCESS-LABEL', sel, log };
                    }
                }
            }
        }

        // Method HI-AMOUNT: items[N.base][customerVisiblePrice][amount] — raw USD numeric value
        // e.g. <input type="hidden" name="items[0.base][customerVisiblePrice][amount]" value="58.88">
        const amountInputs = document.querySelectorAll(
            'input[name*="customerVisiblePrice"][name*="amount"], ' +
            'input[id*="customerVisiblePrice"][id*="amount"]'
        );
        for (const el of amountInputs) {
            const val = (el.value || el.getAttribute('value') || '').trim();
            log.push(`[HI-AMT] ${el.name || el.id}: value="${val}"`);
            const num = parseFloat(val);
            if (!isNaN(num) && num > 0) {
                // Check for currency in siblings or parent
                let currency = '$';
                const parent = el.parentElement;
                if (parent && (parent.textContent.includes('₹') || parent.textContent.toUpperCase().includes('INR'))) {
                    currency = '₹';
                }
                return { price: currency + num.toFixed(2), method: 'HI-AMOUNT', sel: el.name || el.id, log };
            }
        }

        // Method HI: Hidden input with customerVisiblePrice displayString — server-rendered
        const hiddenInputSelectors = [
            'input[name*="customerVisiblePrice"][name*="displayString"]',
            'input[id*="customerVisiblePrice"]',
            'input[name*="customerVisiblePrice"]',
        ];
        for (const sel of hiddenInputSelectors) {
            const el = document.querySelector(sel);
            const val = el ? (el.value || el.getAttribute('value') || '').trim() : null;
            log.push(`[HI] ${sel}: value="${val}"`);
            // Only accept if it looks like a USD value (starts with $ or is a plain number)
            if (val && val.length > 0 && val !== '0' && val !== '₹0' && val !== '$0') {
                // Skip INR values — we want USD only here
                if (val.includes('₹') || val.toUpperCase().startsWith('INR')) {
                    log.push(`[HI] Skipping INR value from displayString: ${val}`);
                    continue;
                }
                return { price: val.startsWith('$') ? val : '$' + val, method: 'HI-HIDDEN-INPUT', sel, log };
            }
        }

        // Method AR: <span aria-hidden="true">$26.95</span> — the visible price Amazon renders
        // Search inside all known buy-box / price containers first, then whole page
        const ariaContainers = [
            '#corePriceDisplay_desktop_feature_div',
            '#corePrice_feature_div',
            '#apex_offerDisplay_desktop',
            '#buyNewSection',
            '#price_inside_buybox',
            '#buybox',
            '#buyBoxAccordion',
            '#newAccordionRow',
            '#unqualified-buybox',
            '#qualifiedBuyBox',
            '#tmmSwatches',
            '#MediaMatrix',
        ];
        // Try within known containers first (most precise)
        for (const containerSel of ariaContainers) {
            const container = document.querySelector(containerSel);
            if (!container) continue;
            const ariaSpans = container.querySelectorAll('span[aria-hidden="true"]');
            for (const span of ariaSpans) {
                const txt = span.textContent.trim();
                if (txt && txt.startsWith('$') && txt !== '$0' && txt !== '$0.00') {
                    log.push(`[AR] ${containerSel} > span[aria-hidden]: "${txt}"`);
                    return { price: txt, method: 'AR-ARIA', sel: containerSel, log };
                }
            }
        }
        // Fallback: any aria-hidden span with $ anywhere on page (not struck-through)
        const allAriaSpans = document.querySelectorAll('span[aria-hidden="true"]');
        for (const span of allAriaSpans) {
            // Skip if parent is a strikethrough (was price / list price)
            const parent = span.closest('span.a-text-strike, .a-text-strike');
            if (parent) continue;
            const txt = span.textContent.trim();
            if (txt && txt.startsWith('$') && txt !== '$0' && txt !== '$0.00') {
                log.push(`[AR-FB] span[aria-hidden]: "${txt}"`);
                return { price: txt, method: 'AR-ARIA-PAGE', log };
            }
        }

        // Method 0: Exact selectors confirmed from DevTools
        const exactSelectors = [
            '#corePrice_feature_div span.apex-pricetopay-value span.a-offscreen',
            '#corePriceDisplay_desktop_feature_div span.apex-pricetopay-value span.a-offscreen',
            '#corePrice_feature_div span.reinventPriceAccordionT2 span.a-offscreen',
            '#corePriceDisplay_desktop_feature_div span.reinventPriceAccordionT2 span.a-offscreen',
        ];
        for (const sel of exactSelectors) {
            const el = document.querySelector(sel);
            const txt = el ? el.textContent.trim() : null;
            log.push(`[0] ${sel}: "${txt}"`);
            if (txt && txt.length > 0 && txt !== '$0' && txt !== '$0.00' && txt !== '₹0' && txt !== '₹0.00') {
                return { price: txt, method: '0-EXACT', sel, log };
            }
        }

        // Method A: .a-offscreen inside known + expanded buy-box containers
        const expandedSelectors = [
            ...selectors,
            '#tmmSwatches', '#newAccordionRow', '#kindle-price', '#MediaMatrix',
            '#unqualified-buybox', '#qualifiedBuyBox', '#soldByThirdParty',
            '#price', '#priceblock_ourprice', '#priceblock_dealprice',
            '#priceblock_saleprice', '#priceblock_pospromoprice',
            '.reinventPriceSignalV2', '.a-button-buybox',
        ];
        for (const sel of expandedSelectors) {
            const container = document.querySelector(sel);
            if (!container) continue;
            const els = container.querySelectorAll('.a-offscreen, .aok-offscreen');
            const vals = Array.from(els).map(el => el.textContent.trim());
            for (const txt of vals) {
                if (txt.length > 0 && txt !== '$0' && txt !== '$0.00' && txt !== '₹0' && txt !== '₹0.00' &&
                    (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))) {
                    log.push(`[A] found in ${sel}: "${txt}"`);
                    return { price: txt, method: 'A-EXP', sel, log };
                }
            }
        }

        // Method B: whole + fraction digits from expanded containers
        for (const sel of expandedSelectors) {
            const container = document.querySelector(sel);
            if (!container) continue;
            const whole = container.querySelector('.a-price-whole');
            const frac = container.querySelector('.a-price-fraction');
            if (whole) {
                const w = whole.textContent.replace(/[^\d]/g, '').trim();
                const f = frac ? frac.textContent.replace(/[^\d]/g, '') : '00';
                if (w && w !== '0' && w.length <= 5) {
                    log.push(`[B] ${sel}: whole="${w}" frac="${f}"`);
                    return { price: w + '.' + f, method: 'B', sel, log };
                }
            }
        }

        // Method C: any .a-offscreen or .aok-offscreen anywhere on page
        const all = document.querySelectorAll('.a-offscreen, .aok-offscreen');
        const allVals = Array.from(all).map(el => el.textContent.trim());
        log.push(`[C] All .a-offscreen (${allVals.length}): ${JSON.stringify(allVals.slice(0, 10))}`);
        for (const txt of allVals) {
            if (txt !== '$0' && txt !== '$0.00' && txt !== '₹0' && txt !== '₹0.00' &&
                (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))) {
                return { price: txt, method: 'C', log };
            }
        }

        // Method D: direct text of specific price element IDs / classes
        const directSelectors = [
            '#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice',
            '#price_inside_buybox', '#kindle-price', '#price',
            '.a-color-price', '#tp_price_block_total_price_ww',
        ];
        for (const sel of directSelectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const txt = el.textContent.trim();
            const m = txt.match(/[$₹][\d,]+\.?\d*/);
            if (m) {
                log.push(`[D] ${sel}: "${m[0]}"`);
                return { price: m[0].replace(/\s/g, ''), method: 'D-DIRECT', sel, log };
            }
        }

        // Method E: first visible span.a-price (not strikethrough)
        const priceSpans = document.querySelectorAll('span.a-price:not(.a-text-strike)');
        for (const span of priceSpans) {
            const off = span.querySelector('.a-offscreen, .aok-offscreen');
            if (off) {
                const txt = off.textContent.trim();
                if (txt && txt !== '$0' && txt !== '$0.00' && txt !== '₹0' && txt !== '₹0.00' &&
                    (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))) {
                    log.push(`[E] span.a-price: "${txt}"`);
                    return { price: txt, method: 'E-SPAN', log };
                }
            }
        }

        // Method F: selected format price (books with format switcher)
        const selectedFormat = document.querySelector('#tmmSwatches .selected .slot-price, #tmmSwatches .a-button-selected .slot-price');
        if (selectedFormat) {
            const txt = selectedFormat.textContent.trim();
            const m = txt.match(/[$₹][\d,]+\.?\d*/);
            if (m) { log.push(`[F] selectedFormat: "${m[0]}"`); return { price: m[0], method: 'F-FORMAT', log }; }
        }

        // Method G: Restrictive page $ sweep — only look in headers/buyboxes
        const sweepContainers = [
            '#corePrice_desktop', '#corePriceDisplay_desktop_feature_div',
            '#buybox', '#buyNewSection', '#price_inside_buybox', '#centerCol'
        ];
        let sweepText = '';
        sweepContainers.forEach(s => {
            const el = document.querySelector(s);
            if (el) sweepText += ' ' + el.innerText;
        });

        const dollarMatches = sweepText.match(/\$\s?\d{1,4}(?:,\d{3})*(?:\.\d{2})?/g) || [];
        const freq = {};
        for (const p of dollarMatches) {
            const clean = p.replace(/\s/g, '');
            if (clean === '$0' || clean === '$0.00' || clean === '$' || clean.length < 2) continue;
            freq[clean] = (freq[clean] || 0) + 1;
        }
        const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0) {
            log.push(`[G] Restricted $ sweep top: ${JSON.stringify(sorted.slice(0, 5))}`);
            return { price: sorted[0][0], method: 'G-SWEEP-RESTRICTED', log };
        }

        return { price: null, method: 'NONE', log };
    }, priceSelectors).catch(err => ({ price: null, method: 'EVAL_ERROR', log: [err.message] }));

    // --- LOG: Detailed DOM evaluation trace ---
    logger.info(`[${asin}] [PRICE] DOM evaluation method used: ${domResult.method}`);
    for (const line of (domResult.log || [])) {
        logger.info(`[${asin}] [PRICE]   ${line}`);
    }
    if (domResult.price) {
        logger.info(`[${asin}] [PRICE] DOM price found via Method ${domResult.method}: "${domResult.price}"`);
    } else {
        logger.warn(`[${asin}] [PRICE] DOM evaluation returned null — no price found in any element`);
    }

    return domResult.price;
}

class ScraperEngine {
    constructor() {
        this.browser = null;
    }

    async init() {
        if (this.browser) return;
        logger.info('[SCRAPER] Launching shared browser instance...');
        this.browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu']
        });
    }

    async createContext() {
        if (!this.browser) await this.init();

        const ua = config.scraper.userAgentPool[Math.floor(Math.random() * config.scraper.userAgentPool.length)];
        const context = await this.browser.newContext({
            userAgent: ua,
            viewport: { width: 1280, height: 800 }, // Fixed viewport
            locale: 'en-US',
            timezoneId: 'America/Los_Angeles', // Changed timezone
            geolocation: { latitude: 37.7749, longitude: -122.4194 }, // Changed geolocation (San Francisco)
            permissions: ['geolocation'],
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'X-Forwarded-For': '98.249.42.117',
                'CF-IPCountry': 'US',
                'CloudFront-Viewer-Country': 'US',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Cookie': 'i18n-prefs=USD; sp-cdn="L=\\"en_US\\""; csm-hit=tb:s-1WPD589R90P8N5W72NZN|1690000000000'
            }
        });

        await context.clearCookies();

        // Aggressive Resource Blocking (v3.0)
        await context.route('**/*', (route, request) => {
            const type = request.resourceType();
            const url = request.url().toLowerCase();

            const blockTypes = ['font', 'media', 'other'];
            const blockDomains = [
                'doubleclick.net', 'google-analytics.com', 'amazon-adsystem.com',
                'assoc-amazon.com', 'fls-na.amazon.com', 'unagi.amazon.com',
                'completion.amazon.com', 'affiliate-program.amazon.com'
            ];

            if (blockTypes.includes(type) || blockDomains.some(d => url.includes(d))) {
                route.abort();
            } else {
                route.continue();
            }
        });

        return context;
    }

    async close() {
        if (this.browser) {
            logger.info('[SCRAPER] Closing shared browser instance...');
            await this.browser.close();
            this.browser = null;
        }
    }

    async getPriceFromScraperAPI(asin) {
        let attempts = 0;
        const maxAttempts = 2; // Increased to 2 for better reliability
        const apiKey = process.env.SCRAPERAPI_KEY;
        if (!apiKey) return null;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                // Layer 1: Structured Product API (Fastest & most accurate)
                const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${apiKey}&asin=${asin}&country=us`;
                
                const res = await axios.get(url, { 
                    timeout: 45000,
                    headers: { 'Accept': 'application/json' }
                });

                if (res.status === 200) {
                    const data = res.data;
                    const price = data?.pricing || data?.price || data?.buybox_price || null;
                    if (price && price.includes('$')) {
                        logger.info(`[${asin}] ScraperAPI-Structured price: ${price}`);
                        return price.trim();
                    }
                }
                
                // If we reach here, structured data found nothing or non-USD.
                // Layer 2: Standard Proxy Fallback (Fetch raw US HTML and parse)
                logger.info(`[${asin}] ScraperAPI-Structured gave no USD. Trying Standard Proxy Fallback...`);
                const proxyUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(`https://www.amazon.com/dp/${asin}`)}&country_code=us`;
                
                const proxyRes = await axios.get(proxyUrl, { timeout: 60000 });
                if (proxyRes.status === 200) {
                    const $ = cheerio.load(proxyRes.data);
                    const alSelectors = ['#apex-pricetopay-accessibility-label', 'span.apex-pricetopay-value .a-offscreen', '.aok-offscreen', '.a-offscreen'];
                    for (const sel of alSelectors) {
                        const txt = $(sel).first().text().trim();
                        if (txt && txt.includes('$')) {
                            const m = txt.match(/([$][\d,]+\.?\d*)/);
                            if (m) {
                                logger.info(`[${asin}] ScraperAPI-Standard fallback found price: ${m[0]}`);
                                return m[0];
                            }
                        }
                    }
                }
                return null; // Both failed
            } catch (e) {
                const isRetryable = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || (e.response && e.response.status >= 500);
                if (isRetryable && attempts < maxAttempts) {
                    const delay = Math.pow(2, attempts) * 1000;
                    logger.warn(`[${asin}] ScraperAPI attempt ${attempts} failed (${e.message}). Retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                logger.warn(`[${asin}] ScraperAPI failed after ${attempts} attempts: ${e.message}`);
                return null;
            }
        }
    }

    async scrapeASIN(product, progressCallback) {
        const { asin, domain } = typeof product === 'string' ? { asin: product, domain: config.scraper.defaultDomain } : product;
        let result = { asin, domain, status: 'FAILED', reason: 'Unknown' };

        // Fix 4: INCREASE HARD CUTOFF TO 90 SECONDS PER ASIN (v13.0)
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('HARD_TIMEOUT')), 90000);
        });

        // Fire API request concurrently!
        const apiPricePromise = this.getPriceFromScraperAPI(asin);

        const performScrape = async () => {
            let context = null;
            let page = null;
            try {
                context = await this.createContext();
                page = await context.newPage();

                const url = `https://${domain}/dp/${asin}?th=1&psc=1&language=en_US&currency=USD&gl=US`;
                logger.info(`[SCRAPER] Scraping ${asin} on ${domain}`);

                let interceptedPrice = null;
                let networkPriceAttempts = 0;

                page.on('response', async (response) => {
                    if (interceptedPrice) return;

                    const reqUrl = response.url().toLowerCase();
                    const contentType = (response.headers()['content-type'] || '').toLowerCase();

                    // Only scan actual API/HTML responses, NOT CSS/JS/image files
                    const isApiOrHtml = (
                        contentType.includes('application/json') ||
                        contentType.includes('text/html') ||
                        contentType.includes('text/plain')
                    );
                    if (!isApiOrHtml) return;

                    const isRelevant = (
                        reqUrl.includes('desktop-offer-display') ||
                        reqUrl.includes('gp/product/ajax') ||
                        reqUrl.includes('aod/ajax') ||
                        reqUrl.includes('offer-listing')
                    );

                    if (isRelevant) {
                        networkPriceAttempts++;
                        try {
                            const text = await response.text();
                            
                            // Better matching strategy: look for "price", "amount", or "displayString" keys near values
                            // Or just find all $ values and pick the one that DOES NOT look like a list price (usually lower)
                            const matches = text.match(/[\$₹]\s?\d+(?:,\d{3})*(?:\.\d{2})?/g);
                            logger.info(`[${asin}] [NET] Relevant URL #${networkPriceAttempts}: ${response.url().split('?')[0]} | matches=${matches ? JSON.stringify(matches.slice(0, 3)) : 'none'}`);
                            
                            if (matches) {
                                // Sort by occurrence (logic: usually the first $ in a product JSON is the primary price)
                                for (const match of matches) {
                                    const cleanMatch = match.replace(/\s/g, '');
                                    // Filter out obviously wrong values
                                    if (cleanMatch !== '$0' && cleanMatch !== '$0.00' && cleanMatch.length > 2) {
                                        interceptedPrice = cleanMatch;
                                        break;
                                    }
                                }
                            }
                        } catch (err) {
                            // logger.warn(`[${asin}] [NET] Response error: ${err.message}`);
                        }
                    }
                });

                // Fix 2: NAVIGATION STRATEGY (v12.0)
                try {
                    await page.goto(url, { 
                        waitUntil: 'load', 
                        timeout: 45000 
                    });
                } catch (e) {
                    logger.warn(`[${asin}] Navigation failed or timed out: ${e.message}`);
                    // Continue anyway, target elements might still be available
                }

                // Check for CAPTCHA (Simplified) (v11.0)
                const pageTitle = (await page.title()) || '';
                const pageUrl = page.url();
                
                if (pageTitle.toLowerCase().includes('robot') || pageTitle.toLowerCase().includes('captcha') || pageTitle.toLowerCase().includes('sorry')) {
                    return { asin, status: 'CAPTCHA_BLOCKED', reason: 'Amazon CAPTCHA block' };
                }

                // Fix 4: NO_PRODUCT Detection (v11.0)
                const hasNoTitleElement = await page.$('#productTitle').then(el => !el).catch(() => true);

                const isNotFound = pageTitle.toLowerCase().includes('page not found') && 
                                  pageUrl.includes('/404') && 
                                  hasNoTitleElement;

                if (isNotFound) {
                    logger.warn(`[${asin}] NO_PRODUCT triggered by: Strict 404 + Title check`);
                    logger.warn(`[${asin}] Page title was: ${pageTitle}`);
                    logger.warn(`[${asin}] Page URL was: ${pageUrl}`);
                    return { asin, status: 'NO_PRODUCT', reason: 'Product unavailable or Page Not Found' };
                }

                // Check for title presence — 25s timeout to handle slow-loading pages
                try {
                    await page.waitForSelector('#productTitle', { timeout: 25000 });
                    logger.info(`[${asin}] #productTitle found — page loaded OK`);
                } catch (e) {
                    const stillNoTitle = await page.$('#productTitle').then(el => !el).catch(() => true);
                    const currentTitle = await page.title().catch(() => '');
                    const currentUrl = page.url();
                    logger.warn(`[${asin}] #productTitle NOT found after 25s | pageTitle="${currentTitle}" | url="${currentUrl}"`);
                    if (stillNoTitle) {
                        return { asin, status: 'NO_PRODUCT', reason: '#productTitle not found after 25s' };
                    }
                }

                // Wait 1.2 seconds to allow network responses to complete
                await page.waitForTimeout(1200);

                logger.info(`[${asin}] [PRICE] Network interception scan complete. Total relevant responses seen: ${networkPriceAttempts}`);
                logger.info(`[${asin}] [PRICE] Intercepted price from network: ${interceptedPrice || 'null (none found)'}`);

                // Page summary before extraction
                const pageSummary = await page.evaluate(() => ({
                    title: document.title,
                    url: location.href,
                    bodyLen: document.body ? document.body.innerHTML.length : 0,
                    hasProductTitle: !!document.querySelector('#productTitle'),
                    hasBuyBox: !!document.querySelector('#buybox, #buyBoxAccordion, #add-to-cart-button'),
                    hasCorePrice: !!document.querySelector('#corePriceDisplay_desktop_feature_div, #corePrice_feature_div'),
                    hasApexOffer: !!document.querySelector('#apex_offerDisplay_desktop'),
                    hasPriceInsideBuybox: !!document.querySelector('#price_inside_buybox'),
                    allOffscreen: Array.from(document.querySelectorAll('.a-offscreen, .aok-offscreen')).map(e => e.textContent.trim()).slice(0, 15),
                })).catch(() => ({}));
                logger.info(`[${asin}] [PAGE-SUMMARY] title="${pageSummary.title}" url="${pageSummary.url}"`);
                logger.info(`[${asin}] [PAGE-SUMMARY] bodyLen=${pageSummary.bodyLen} productTitle=${pageSummary.hasProductTitle} buyBox=${pageSummary.hasBuyBox}`);
                logger.info(`[${asin}] [PAGE-SUMMARY] corePrice=${pageSummary.hasCorePrice} apexOffer=${pageSummary.hasApexOffer} priceInsideBuybox=${pageSummary.hasPriceInsideBuybox}`);
                logger.info(`[${asin}] [PAGE-SUMMARY] all .a-offscreen: ${JSON.stringify(pageSummary.allOffscreen)}`);

                // PRICE EXTRACTION (v15.0) — JSON/meta USD first (real US price), then DOM, then network
                logger.info(`[${asin}] [PRICE] Network scan complete. Relevant responses seen: ${networkPriceAttempts}. Intercepted: ${interceptedPrice || 'none'}`);

                // Step 1: Try to extract real USD price from embedded JSON/meta in page source
                // This is the most accurate method \u2014 Amazon always embeds the actual US price here
                logger.info(`[${asin}] [PRICE] Step 1: Trying JSON/meta USD extraction...`);
                let livePrice = await extractUSDFromPageJSON(page, asin);

                // Step 2: DOM extraction (may return INR if Amazon detected Indian IP)
                if (!livePrice) {
                    logger.info(`[${asin}] [PRICE] Step 2: JSON failed. Running DOM extraction...`);
                    const domPrice = await getAmazonPrice(page);
                    if (domPrice) {
                        // Only use DOM price if it is already USD (starts with $)
                        // If it's INR, we'll try convert as last resort
                        if (domPrice.startsWith('$')) {
                            livePrice = domPrice;
                            logger.info(`[${asin}] [PRICE] ✔ DOM extraction gave USD price: ${livePrice}`);
                        } else {
                            logger.info(`[${asin}] [PRICE] DOM gave non-USD price: ${domPrice} — ignoring as inaccurate for US targeting`);
                        }
                    } else if (interceptedPrice && interceptedPrice.startsWith('$')) {
                        livePrice = interceptedPrice;
                        logger.info(`[${asin}] [PRICE] Step 3: Using network fallback: ${livePrice}`);
                    } else {
                        logger.warn(`[${asin}] [PRICE] No USD prices found in local DOM/Network.`);
                    }
                }
                
                // Wait for the concurrent API price to finish
                const apiPrice = await apiPricePromise;
                const finalPrice = (apiPrice && apiPrice.includes('$')) ? apiPrice : livePrice;

                logger.info(`[${asin}] [PRICE] ════════════════════════════════════════════════════════════`);
                logger.info(`[${asin}] [PRICE] SCRAPER API: ${apiPrice || 'FAILED/NULL'}`);
                logger.info(`[${asin}] [PRICE] LOCAL LIVE: ${livePrice || 'FAILED/NULL'}`);
                logger.info(`[${asin}] [PRICE] ❯❯❯ FINAL RESOLVED: ${finalPrice || 'N/A'}`);
                logger.info(`[${asin}] [PRICE] ════════════════════════════════════════════════════════════`);

                const data = await this.extractWithCheerio(
                    page, asin, progressCallback, livePrice, apiPrice
                );

                if (data.title === 'N/A') {
                    return { asin, status: 'NO_PRODUCT', reason: 'Page loaded but no product details found' };
                }

                return { asin, status: 'SUCCESS', data };

            } catch (error) {
                if (error.message === 'HARD_TIMEOUT') {
                    logger.warn(`[${asin}] Skipped — timed out after 90s`);
                    return { asin, status: 'PAGE_TIMEOUT', reason: 'HARD_TIMEOUT' };
                }
                logger.error(`[SCRAPER] Scrape error for ${asin}: ${error.message}`);
                return { asin, status: 'FAILED', reason: error.message };
            } finally {
                if (context) await context.close();
            }
        };

        try {
            result = await Promise.race([performScrape(), timeoutPromise]);
        } catch (error) {
            if (error.message === 'HARD_TIMEOUT') {
                logger.warn(`[${asin}] Skipped — timed out after 90s`);
                result = { asin, status: 'PAGE_TIMEOUT', reason: 'HARD_TIMEOUT' };
            } else {
                result = { asin, status: 'FAILED', reason: error.message };
            }
        }

        return result;
    }

    async extractWithCheerio(page, asin, progressCallback, livePrice = null, apiPrice = null) {
        const html = await page.content();
        const $ = cheerio.load(html);

        // DEBUG LOGS (Keep for visibility)
        const bodyText = $('body').text();
        const hasINR = bodyText.includes('₹');
        const hasUSD = bodyText.includes('$');
        logger.info(`[${asin}] PRICE DEBUG: INR=${hasINR} USD=${hasUSD}`);

        const results = {
            asin,
            title: 'N/A',
            brand: 'N/A',
            price: 'N/A',
            reviews: 'N/A',
            stars: 'N/A',
            bsr: 'N/A',
            form: 'N/A',
            size: 'N/A',
            imageUrl: '',
            timestamp: new Date().toISOString()
        };

        const details = {};
        const cleanKey = (k) => k.toLowerCase().replace(/[:\u2022\u200b]/g, '').trim();
        const cleanVal = (v) => cleanText(v);

        $('#productDetails_techSpec_section_1 tr, #table_productDetails_db_sections tr, .a-expander-content table tr').each((i, el) => {
            const th = $(el).find('th').text().trim();
            const td = $(el).find('td').text().trim();
            if (th && td) details[cleanKey(th)] = cleanVal(td);
        });

        $('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li').each((i, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (text.includes(':')) {
                const parts = text.split(':');
                details[cleanKey(parts[0])] = cleanVal(parts.slice(1).join(':'));
            }
        });

        // Image Extraction
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

        // ScraperAPI = most accurate USD price
        if (apiPrice && apiPrice.includes('$')) {
            results.price = apiPrice;
            logger.info(`[${asin}] Using ScraperAPI price`);
        } else if (livePrice) {
            results.price = livePrice;
            logger.info(`[${asin}] Using live DOM price`);
        } else {
            results.price = 'N/A';
        }

        // Final Price Fallback using Accessibility Labels (same as DOM AL method but for Cheerio)
        if (results.price === 'N/A' || !results.price) {
            const alSelectors = ['#apex-pricetopay-accessibility-label', 'span.apex-pricetopay-value .a-offscreen', '.aok-offscreen', '.a-offscreen'];
            for (const sel of alSelectors) {
                const el = $(sel).first();
                if (el.length) {
                    const txt = el.text().trim();
                    // FILTER: If on .com, only accept $
                    const isDotCom = asin.toLowerCase().includes('http') ? asin.includes('amazon.com') : true; // assume .com if asin only
                    if (isDotCom && !txt.includes('$')) continue;

                    const m = txt.match(/([$₹][\d,]+\.?\d*|INR\s?[\d,]+\.?\d*)/i);
                    if (m && m[0] && m[0] !== '$0' && m[0] !== '₹0') {
                        results.price = m[0];
                        logger.info(`[${asin}] [PRICE] Cheerio AL fallback found price via ${sel}: ${results.price}`);
                        break;
                    }
                }
            }
        }

        // Cheerio fallback: hidden input with customerVisiblePrice (server-rendered)
        if (results.price === 'N/A' || !results.price) {
            const hiddenInput = $('input[name*="customerVisiblePrice"][name*="displayString"]').first();
            if (!hiddenInput.length) {
                // Also try by id
                $('input[id*="customerVisiblePrice"]').each((i, el) => {
                    if (results.price === 'N/A' || !results.price) {
                        const val = $(el).attr('value') || '';
                        if (val && val.length > 0 && val !== '0') results.price = cleanText(val);
                    }
                });
            } else {
                const val = hiddenInput.attr('value') || '';
                if (val && val.length > 0 && val !== '0') results.price = cleanText(val);
            }
            if (results.price !== 'N/A') {
                logger.info(`[${asin}] [PRICE] Cheerio hidden-input fallback found price: ${results.price}`);
            } else {
                logger.warn(`[${asin}] [PRICE] Cheerio hidden-input fallback: no customerVisiblePrice input found in HTML`);
            }
        }
        // Final BSR, Reviews, Stars...
        if (details['best sellers rank']) {
            const m = details['best sellers rank'].match(/#([\d,]+)/);
            if (m) results.bsr = m[1].replace(/,/g, '');
        }
        
        const starText = $('#acrPopover').attr('title') || $('.a-icon-star').text();
        const starMatch = starText ? starText.match(/(\d+\.?\d*)/) : null;
        if (starMatch) results.stars = cleanText(starMatch[1]);

        const revEl = $('#acrCustomerReviewText');
        if (revEl.length) {
            const revMatch = cleanText(revEl.text()).match(/(\d[\d,]*)/);
            if (revMatch) results.reviews = revMatch[1].replace(/,/g, '');
        }

        const formKeys = ['item form', 'form', 'format'];
        for (const k of formKeys) { if (details[k]) { results.form = cleanText(details[k]); break; } }

        const combinedText = (results.title + ' ' + $('body').text()).toLowerCase();
        const sizeMatch = combinedText.match(/(\d+\.?\d*\s?(lbs?|oz|lb|kg|g|fl\s?oz|count|ct))/i);
        if (sizeMatch) results.size = cleanText(sizeMatch[0]);

        // Cleanup
        for (const key in results) {
            if (typeof results[key] === 'string') results[key] = cleanText(results[key]);
        }

        return results;
    }

    async extractData(page, asin, progressCallback) {
        return this.extractWithCheerio(page, asin, progressCallback);
    }
}

module.exports = new ScraperEngine();
