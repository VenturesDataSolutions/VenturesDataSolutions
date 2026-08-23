const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('privacy.html');
assertCommonChrome(html, 'Privacy');
assert(/no.*resale|do not sell/i.test(html), 'Privacy: missing no-data-resale statement');
assert(html.includes('Stripe'), 'Privacy: should mention Stripe as a payment data collection point (even though checkout is not live yet)');

console.log('PASS: privacy.test.js');
