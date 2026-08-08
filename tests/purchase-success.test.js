const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('purchase-success.html');
assertCommonChrome(html, 'Purchase Success');
assert(html.includes('id="manage-subscription-link"'), 'Purchase Success: missing manage-subscription link');
assert(html.includes('src="assets/purchase-success.js"'), 'Purchase Success: missing purchase-success.js script tag');

console.log('PASS: purchase-success.test.js');
