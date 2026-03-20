const logger = require('./logger');
const config = require('./config');
const cheerio = require('cheerio');
const axios = require('axios');

function cleanText(str) {
    if (!str || str === 'N/A') return str;
    return str
        .replace(/[\u200e\u200f\u200b\u200c\u200d\u00ad\ufeff\u2022]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

class ScraperEngine {
    constructor() {}

    async init() {}
    async close() {}

    async getPriceFromScraperAPI(asin) {
        let attempts = 0;
        const maxAttempts = 2;
        const apiKey = process.env.SCRAPERAPI_KEY;
        if (!apiKey) return null;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${apiKey}&asin=${asin}&country=us`;
                const res = await axios.get(url, { timeout: 45000, headers: { 'Accept': 'application/json' }});
                if (res.status === 200) {
                    const data = res.data;
                    const price = data?.pricing || data?.price || data?.buybox_price || null;
                    if (price && price.includes('$')) {
                        logger.info(`[${asin}] ScraperAPI-Structured price: ${price}`);
                        return price.trim();
                    }
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

    async getHTMLFromScraperAPI(asin, domain) {
        let attempts = 0;
        const maxAttempts = 2;
        const apiKey = process.env.SCRAPERAPI_KEY;
        const targetUrl = `https://${domain}/dp/${asin}?th=1&psc=1&language=en_US&currency=USD&gl=US`;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                let url;
                if (apiKey) {
                    url = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
                } else {
                    url = targetUrl;
                }
                const res = await axios.get(url, { 
                    timeout: 45000,
                    headers: apiKey ? {} : {
                        'User-Agent': config.scraper.userAgentPool[0] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                if (res.status === 200) {
                    return res.data;
                }
            } catch (e) {
                logger.warn(`[${asin}] Error fetching HTML: ${e.message}`);
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

        const [apiPrice, html] = await Promise.all([apiPricePromise, htmlPromise]);

        if (!html) {
            return { asin, status: 'FAILED', reason: 'Failed to retrieve page HTML' };
        }

        const data = this.extractWithCheerio(html, asin, apiPrice);

        if (data.title === 'N/A' || data.title === '') {
            return { asin, status: 'NO_PRODUCT', reason: 'Page loaded but no product details found' };
        }

        return { asin, status: 'SUCCESS', data };
    }

    extractWithCheerio(html, asin, apiPrice = null) {
        const $ = cheerio.load(html);

        const results = {
            asin, title: 'N/A', brand: 'N/A', price: 'N/A', reviews: 'N/A',
            stars: 'N/A', bsr: 'N/A', form: 'N/A', size: 'N/A', imageUrl: '',
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

        if (apiPrice && apiPrice.includes('$')) {
            results.price = apiPrice;
            logger.info(`[${asin}] Using ScraperAPI price`);
        } else {
            results.price = 'N/A';
        }

        if (results.price === 'N/A') {
            const alSelectors = ['#apex-pricetopay-accessibility-label', 'span.apex-pricetopay-value .a-offscreen', '.aok-offscreen', '.a-offscreen'];
            for (const sel of alSelectors) {
                const el = $(sel).first();
                if (el.length) {
                    const txt = el.text().trim();
                    const m = txt.match(/([$₹][\d,]+\.?\d*|INR\s?[\d,]+\.?\d*)/i);
                    if (m && m[0] && m[0] !== '$0' && m[0] !== '₹0') {
                        if (m[0].includes('$')) {
                            results.price = m[0];
                            break;
                        }
                    }
                }
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

        for (const key in results) {
            if (typeof results[key] === 'string') results[key] = cleanText(results[key]);
        }

        return results;
    }
}

module.exports = new ScraperEngine();
