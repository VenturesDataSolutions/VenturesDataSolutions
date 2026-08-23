const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('terms.html');
assertCommonChrome(html, 'Terms');
assert(/recurring/i.test(html), 'Terms: missing recurring-subscription language');
assert(/cancel/i.test(html) && /any time|anytime/i.test(html), 'Terms: missing cancel-anytime language');
assert(/no fee|no penalt/i.test(html), 'Terms: missing no-fees/no-penalty language');

console.log('PASS: terms.test.js');
