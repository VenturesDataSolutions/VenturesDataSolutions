const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('purchase-success.html');
assertCommonChrome(html, 'Purchase Success');
assert(html.includes('id="manage-subscription-link"'), 'Purchase Success: missing manage-subscription link');
assert(html.includes('src="assets/purchase-success.js"'), 'Purchase Success: missing purchase-success.js script tag');
assert(html.includes('<meta name="referrer" content="no-referrer">'), 'Purchase Success: missing no-referrer meta tag — session_id (the entire self-cancel auth credential) must not leak via the Referer header to same-origin nav links');

const js = readPage('assets/purchase-success.js');
assert(/requestInFlight/.test(js), 'Purchase Success: missing double-submit guard on the manage-subscription click handler');

console.log('PASS: purchase-success.test.js');
