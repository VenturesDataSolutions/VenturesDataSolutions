const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('contact.html');
assertCommonChrome(html, 'Contact');

// The phone placeholder must be plain text, not wrapped in a live link of any kind.
const phoneLineMatch = html.match(/<[^>]*>\[ phone number coming soon \]<\/[^>]*>/);
assert(phoneLineMatch, 'Contact: phone placeholder should be in a plain text element');
assert(!/<a[^>]*>\s*\[ phone number coming soon \]/.test(html), 'Contact: phone placeholder must not be wrapped in an <a> tag');

console.log('PASS: contact.test.js');
