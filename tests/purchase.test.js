const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('purchase.html');
assertCommonChrome(html, 'Purchase');
assert(html.includes('aria-disabled="true"'), 'Purchase: Claim button must be marked aria-disabled="true"');
assert(/coming soon/i.test(html), 'Purchase: missing a visible "coming soon" state on the disabled button');
assert(!html.includes('<form'), 'Purchase: must not contain a live form until the backend round');
assert(!/onclick\s*=/.test(html), 'Purchase: must not contain inline onclick handlers pretending to submit/checkout');
assert(html.includes('$150'), 'Purchase: missing price');
assert(html.includes('mailto:hello@venturesdatasolutions.com'), 'Purchase: missing fallback email contact for claiming a county now');

console.log('PASS: purchase.test.js');
