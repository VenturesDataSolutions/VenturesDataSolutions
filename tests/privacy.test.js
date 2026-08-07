const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('privacy.html');
assertCommonChrome(html, 'Privacy');
assert(/draft-banner/.test(html), 'Privacy: missing visible draft banner element');
assert(/pending legal review/i.test(html), 'Privacy: draft banner must say it is pending legal review');
assert(/no.*resale|do not sell/i.test(html), 'Privacy: missing no-data-resale statement');
assert(html.includes('Stripe'), 'Privacy: should mention Stripe as a payment data collection point (even though checkout is not live yet)');

console.log('PASS: privacy.test.js');
