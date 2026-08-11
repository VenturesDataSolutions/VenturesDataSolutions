const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('how-it-works.html');
assertCommonChrome(html, 'How It Works');
assert(html.includes('Pull'), 'How It Works: missing Pull step');
assert(html.includes('Parse'), 'How It Works: missing Parse step');
assert(html.includes('Deliver'), 'How It Works: missing Deliver step');
assert(/one subscriber per county/i.test(html), 'How It Works: missing plain-language exclusivity explanation');
assert(html.includes('href="county-data.html"'), 'How It Works: missing link into County Data');

console.log('PASS: how-it-works.test.js');
