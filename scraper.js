const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const logger = require('./logger');
const config = require('./config');
const { delay } = require('./utils');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');

chromium.use(stealth);

function cleanText(str) {
    if (!str || str === 'N/A') return str;
    // Remove ALL non-printable and special invisible characters
    return str
        .replace(/[\u200e\u200f\u200b\u200c\u200d\u00ad\ufeff\u2022]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
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
        Array.from(document.querySelectorAll('.a-offscreen')).map(el => el.textContent.trim())
    ).catch(() => []);
    logger.info(`[${asin}] [PRICE] .a-offscreen values BEFORE wait (${offscreenBefore.length} found): ${JSON.stringify(offscreenBefore.slice(0, 10))}`);

    // Wait for price — checks the exact DevTools selector first, then falls back
    let waitResult = 'resolved';
    try {
        await page.waitForFunction(() => {
            // Method 0: Exact selector confirmed from DevTools
            const exactEl = document.querySelector(
                '#corePrice_feature_div span.apex-pricetopay-value span.a-offscreen, ' +
                '#corePriceDisplay_desktop_feature_div span.apex-pricetopay-value span.a-offscreen'
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
            const all = document.querySelectorAll('.a-offscreen');
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
        Array.from(document.querySelectorAll('.a-offscreen')).map(el => el.textContent.trim())
    ).catch(() => []);
    logger.info(`[${asin}] [PRICE] .a-offscreen values AFTER wait (${offscreenAfter.length} found): ${JSON.stringify(offscreenAfter.slice(0, 10))}`);

    // Read price from live DOM with per-method logging
    const domResult = await page.evaluate((selectors) => {
        const log = [];

        // Method HI: Hidden input with customerVisiblePrice — server-rendered, most reliable
        const hiddenInputSelectors = [
            'input[name*="customerVisiblePrice"][name*="displayString"]',
            'input[id*="customerVisiblePrice"]',
            'input[name*="customerVisiblePrice"]',
        ];
        for (const sel of hiddenInputSelectors) {
            const el = document.querySelector(sel);
            const val = el ? (el.value || el.getAttribute('value') || '').trim() : null;
            log.push(`[HI] ${sel}: value="${val}"`);
            if (val && val.length > 0 && val !== '0' && val !== '₹0' && val !== '$0') {
                return { price: val, method: 'HI-HIDDEN-INPUT', sel, log };
            }
        }

        // Method 0: Exact selectors confirmed from DevTools — high priority
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

        // Method A: any .a-offscreen inside known buy-box containers
        for (const sel of selectors) {
            const container = document.querySelector(sel);
            if (!container) { log.push(`[A] ${sel}: container NOT found`); continue; }
            const els = container.querySelectorAll('.a-offscreen');
            const vals = Array.from(els).map(el => el.textContent.trim());
            log.push(`[A] ${sel}: offscreen values = ${JSON.stringify(vals)}`);
            for (const txt of vals) {
                if (
                    txt.length > 0 &&
                    txt !== '$0' && txt !== '$0.00' &&
                    txt !== '₹0' && txt !== '₹0.00' &&
                    (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))
                ) return { price: txt, method: 'A', sel, log };
            }
        }

        // Method B: whole + fraction in buy box
        for (const sel of selectors) {
            const container = document.querySelector(sel);
            if (!container) continue;
            const whole = container.querySelector('.a-price-whole');
            const frac = container.querySelector('.a-price-fraction');
            const wTxt = whole ? whole.textContent.trim() : null;
            const fTxt = frac ? frac.textContent.trim() : null;
            log.push(`[B] ${sel}: whole="${wTxt}" frac="${fTxt}"`);
            if (whole) {
                const w = whole.textContent.replace(/[^\d]/g, '').trim();
                const f = frac ? frac.textContent.replace(/[^\d]/g, '') : '00';
                if (w && w !== '0' && w.length <= 5) return { price: w + '.' + f, method: 'B', sel, log };
            }
        }

        // Method C: fallback any offscreen not $0
        const all = document.querySelectorAll('.a-offscreen');
        const allVals = Array.from(all).map(el => el.textContent.trim());
        log.push(`[C] All .a-offscreen (${allVals.length}): ${JSON.stringify(allVals.slice(0, 10))}`);
        for (const txt of allVals) {
            if (
                txt !== '$0' && txt !== '$0.00' &&
                txt !== '₹0' && txt !== '₹0.00' &&
                (txt.includes('$') || txt.includes('₹') || txt.includes('INR'))
            ) return { price: txt, method: 'C', log };
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
        const viewport = [
            { width: 1366, height: 768 },
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 }
        ][Math.floor(Math.random() * 3)];

        const context = await this.browser.newContext({
            userAgent: ua,
            viewport: viewport,
            locale: 'en-US',
            timezoneId: 'America/New_York',
            geolocation: { latitude: 40.7128, longitude: -74.0060 },
            permissions: ['geolocation'],
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'X-Forwarded-For': '98.249.42.117',
                'CF-IPCountry': 'US',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
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

    async scrapeASIN(product, progressCallback) {
        const { asin, domain } = typeof product === 'string' ? { asin: product, domain: config.scraper.defaultDomain } : product;
        let result = { asin, domain, status: 'FAILED', reason: 'Unknown' };

        // Fix 4: INCREASE HARD CUTOFF TO 50 SECONDS PER ASIN (v12.0)
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('HARD_TIMEOUT')), 60000);
        });

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
                            const matches = text.match(/[\$₹]\s?\d+(?:,\d{3})*(?:\.\d{2})?/g);
                            logger.info(`[${asin}] [NET] Relevant URL #${networkPriceAttempts}: ${response.url().split('?')[0]} | status=${response.status()} | price matches=${matches ? JSON.stringify(matches.slice(0, 5)) : 'none'}`);
                            if (matches) {
                                for (const match of matches) {
                                    const cleanMatch = match.replace(/\s/g, '');
                                    if (cleanMatch !== '$0' && cleanMatch !== '$0.00' && cleanMatch !== '₹0' && cleanMatch !== '₹0.00') {
                                        interceptedPrice = cleanMatch;
                                        logger.info(`[${asin}] [NET] ✔ Network price captured: ${interceptedPrice}`);
                                        break;
                                    }
                                }
                            }
                        } catch (err) {
                            logger.warn(`[${asin}] [NET] Could not read response body for ${response.url().split('?')[0]}: ${err.message}`);
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
                    allOffscreen: Array.from(document.querySelectorAll('.a-offscreen')).map(e => e.textContent.trim()).slice(0, 15),
                })).catch(() => ({}));
                logger.info(`[${asin}] [PAGE-SUMMARY] title="${pageSummary.title}" url="${pageSummary.url}"`);
                logger.info(`[${asin}] [PAGE-SUMMARY] bodyLen=${pageSummary.bodyLen} productTitle=${pageSummary.hasProductTitle} buyBox=${pageSummary.hasBuyBox}`);
                logger.info(`[${asin}] [PAGE-SUMMARY] corePrice=${pageSummary.hasCorePrice} apexOffer=${pageSummary.hasApexOffer} priceInsideBuybox=${pageSummary.hasPriceInsideBuybox}`);
                logger.info(`[${asin}] [PAGE-SUMMARY] all .a-offscreen: ${JSON.stringify(pageSummary.allOffscreen)}`);

                // PRICE EXTRACTION (v14.0) — DOM first, network as last resort
                // DOM is more accurate; network interception can pick up wrong prices from JS bundles
                logger.info(`[${asin}] [PRICE] Network scan complete. Relevant responses seen: ${networkPriceAttempts}. Intercepted: ${interceptedPrice || 'none'}`);

                logger.info(`[${asin}] [PRICE] Running DOM extraction (primary)...`);
                let livePrice = await getAmazonPrice(page);

                if (livePrice) {
                    logger.info(`[${asin}] [PRICE] ✔ DOM extraction succeeded: ${livePrice}`);
                } else if (interceptedPrice) {
                    livePrice = interceptedPrice;
                    logger.info(`[${asin}] [PRICE] DOM found nothing. Using network-intercepted fallback: ${livePrice}`);
                } else {
                    logger.warn(`[${asin}] [PRICE] Both DOM and network interception returned nothing.`);
                }

                logger.info(`[${asin}] [PRICE] ══ FINAL RESOLVED PRICE: ${livePrice || 'N/A (not found)'} ══`);

                // Pass livePrice into extractWithCheerio
                const data = await this.extractWithCheerio(
                    page, asin, progressCallback, livePrice
                );

                if (data.title === 'N/A') {
                    return { asin, status: 'NO_PRODUCT', reason: 'Page loaded but no product details found' };
                }

                return { asin, status: 'SUCCESS', data };

            } catch (error) {
                if (error.message === 'HARD_TIMEOUT') {
                    logger.warn(`[${asin}] Skipped — timed out after 60s`);
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
                logger.warn(`[${asin}] Skipped — timed out after 60s`);
                result = { asin, status: 'PAGE_TIMEOUT', reason: 'HARD_TIMEOUT' };
            } else {
                result = { asin, status: 'FAILED', reason: error.message };
            }
        }

        return result;
    }

    async extractWithCheerio(page, asin, progressCallback, livePrice = null) {
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

        results.price = livePrice || 'N/A';

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
