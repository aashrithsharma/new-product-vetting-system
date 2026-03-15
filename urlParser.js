const logger = require('./logger');
const config = require('./config');

/**
 * Robust ASIN Extraction (v9.0)
 * Extracts a 10-character Amazon Standard Identification Number from various URL formats or raw strings.
 */
function extractAsin(input) {
    if (!input || typeof input !== 'string') return null;

    logger.info(`[PARSER] Request to extract ASIN from: "${input}"`);

    // Step 1: Clean basic whitespace and carriage returns
    let val = input.trim().replace(/\r/g, '');
    if (!val) {
        logger.warn(`[PARSER] Empty input after trim`);
        return null;
    }

    // Step 2: More aggressive cleaning for common prefixes
    val = val.replace(/^[\s.\-\u2022\u200b]+/, '');

    // Step 3: Check for /dp/ or /gp/product/
    const dpMatch = val.match(/\/(dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (dpMatch) {
        const asin = dpMatch[2].toUpperCase();
        logger.info(`[PARSER] Found via DP/GP pattern: ${asin}`);
        return asin;
    }

    // Step 4: Check for asin= parameter
    const queryMatch = val.match(/[?&]asin=([A-Z0-9]{10})([&]|$)/i);
    if (queryMatch) {
        const asin = queryMatch[1].toUpperCase();
        logger.info(`[PARSER] Found via query param: ${asin}`);
        return asin;
    }

    // Step 5: Check for raw ASIN 
    if (/^[A-Z0-9]{10}$/i.test(val)) {
        const asin = val.toUpperCase();
        logger.info(`[PARSER] Found via raw match: ${asin}`);
        return asin;
    }

    // Step 6: Check for short/pretty URLs or other mentions
    const lazyMatch = val.match(/\b(B[A-Z0-9]{9})\b/i);
    if (lazyMatch) {
        const asin = lazyMatch[1].toUpperCase();
        logger.info(`[PARSER] Found via boundary match: ${asin}`);
        return asin;
    }

    logger.warn(`[PARSER] Failed to find ASIN in: "${val}"`);
    return null;
}

/**
 * Extract ASIN and Domain from input
 */
function parseInput(input) {
    logger.info(`[PARSER] parseInput received: "${input}"`);
    const asin = extractAsin(input);
    
    if (!asin) {
        logger.warn(`[PARSER] parseInput failed for: "${input}"`);
        return null;
    }

    // Final Validation
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
        logger.error(`[PARSER] Invalid ASIN format detected: ${asin}`);
        return null;
    }

    let domain = config.scraper.defaultDomain || 'amazon.com';

    // If input is a URL, try to extract the specific Amazon domain
    if (input.includes('amazon.')) {
        const domainMatch = input.match(/amazon\.([a-z.]{2,6})\b/i);
        if (domainMatch) {
            domain = `amazon.${domainMatch[1]}`;
        }
    }

    const result = { asin, domain, originalUrl: input };
    logger.info(`[PARSER] Success: ${JSON.stringify(result)}`);
    return result;
}

/**
 * Legacy support for search/category expansions
 */
async function parseAmazonUrl(url) {
    const parsed = parseInput(url);
    if (parsed) return [parsed.asin];
    return [];
}

module.exports = { extractAsin, parseInput, parseAmazonUrl };
