const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('terms.html');
assertCommonChrome(html, 'Terms');
assert(/draft-banner/.test(html), 'Terms: missing visible draft banner element');
assert(/pending legal review/i.test(html), 'Terms: draft banner must say it is pending legal review');
assert(/recurring/i.test(html), 'Terms: missing recurring-subscription language');
assert(/cancel/i.test(html) && /any time|anytime/i.test(html), 'Terms: missing cancel-anytime language');
assert(/no fee|no penalt/i.test(html), 'Terms: missing no-fees/no-penalty language');

console.log('PASS: terms.test.js');
