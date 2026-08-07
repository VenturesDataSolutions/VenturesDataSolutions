const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('pricing.html');
assertCommonChrome(html, 'Pricing');
assert(html.includes('$150'), 'Pricing: missing $150/mo price');
assert(html.includes('$300'), 'Pricing: missing $300 first-month-once-full framing');
assert(/cancel anytime/i.test(html), 'Pricing: missing cancel-anytime messaging');
assert(/no fee/i.test(html), 'Pricing: missing no-fee messaging');
assert(html.includes('href="purchase.html"'), 'Pricing: missing CTA link into Purchase');

console.log('PASS: pricing.test.js');
