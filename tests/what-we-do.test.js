const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('what-we-do.html');
assertCommonChrome(html, 'What We Do');
assert(html.includes('mailto:sales@venturesdatasolutions.com'), 'What We Do: missing sales@ contact link');

console.log('PASS: what-we-do.test.js');
