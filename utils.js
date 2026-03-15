const logger = require('./logger');

/**
 * Common delay function
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Clean strings of weird characters and whitespace
 */
const cleanString = (str) => {
    if (!str) return 'N/A';
    return str.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim() || 'N/A';
};

/**
 * Parse numeric values from string
 */
const parseInteger = (str) => {
    if (!str) return 'N/A';
    const match = str.replace(/,/g, '').match(/(\d+)/);
    return match ? parseInt(match[1]) : 'N/A';
};

const parseFloatVal = (str) => {
    if (!str) return 'N/A';
    const match = str.replace(/,/g, '').match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 'N/A';
};

module.exports = {
    delay,
    cleanString,
    parseInteger,
    parseFloatVal
};
