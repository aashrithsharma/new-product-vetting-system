/**
 * BSR to Daily Sales Estimation
 * Specifications:
 * BSR 1-100 = 500 units/day
 * BSR 101-500 = 200
 * BSR 501-1000 = 100
 * BSR 1001-3000 = 50
 * BSR 3001-5000 = 30
 * BSR 5001-10000 = 15
 * BSR 10001-20000 = 8
 * BSR 20001-50000 = 3
 * BSR > 50000 = 1
 */
function estimateDailySales(bsr) {
    if (typeof bsr !== 'number' || isNaN(bsr)) return 'N/A';

    if (bsr <= 100) return 500;
    if (bsr <= 500) return 200;
    if (bsr <= 1000) return 100;
    if (bsr <= 3000) return 50;
    if (bsr <= 5000) return 30;
    if (bsr <= 10000) return 15;
    if (bsr <= 20000) return 8;
    if (bsr <= 50000) return 3;
    return 1;
}

module.exports = { estimateDailySales };
