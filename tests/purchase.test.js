const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('purchase.html');
assertCommonChrome(html, 'Purchase');
assert(html.includes('id="county-input"'), 'Purchase: missing county search input');
assert(html.includes('id="county-list"'), 'Purchase: missing county datalist');
assert(html.includes('id="claim-btn"'), 'Purchase: missing claim button');
assert(html.includes('aria-disabled="true"') && html.includes('disabled'), 'Purchase: claim button must start disabled until a county is selected');
assert(html.includes('src="assets/purchase.js"'), 'Purchase: missing purchase.js script tag');
assert(!/onclick\s*=/.test(html), 'Purchase: must not use inline onclick handlers');
assert(html.includes('$150'), 'Purchase: missing price');
assert(/1.{1,2}7 business days/.test(html), 'Purchase: missing refund disclaimer');
assert(html.includes('mailto:hello@venturesdatasolutions.com'), 'Purchase: missing fallback email contact');

console.log('PASS: purchase.test.js');
