const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('county-data.html');
assertCommonChrome(html, 'County Data');
assert(html.includes('$150'), 'County Data: missing $150/mo price');
assert(html.includes('$300'), 'County Data: missing $300 first-month-once-full framing');
assert(/cancel anytime/i.test(html), 'County Data: missing cancel-anytime messaging');
assert(/no fee/i.test(html), 'County Data: missing no-fee messaging');
assert(html.includes('href="purchase.html"'), 'County Data: missing CTA link into Purchase');
assert(/one subscriber per county/i.test(html), 'County Data: missing exclusivity messaging');
assert(/separate/i.test(html) && /platform/i.test(html), 'County Data: missing language distinguishing it from the Investor/Agent platforms');
assert(!/includes.{0,40}(county leads|exclusive leads)/i.test(html), 'County Data: must not claim the platform products include exclusive county leads');

console.log('PASS: county-data.test.js');
