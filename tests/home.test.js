const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('index.html');
assertCommonChrome(html, 'Home');
assert(html.includes('href="pricing.html"'), 'Home: missing link into Pricing');
assert(html.includes('href="how-it-works.html"'), 'Home: missing link into How It Works');
assert(html.includes('One subscriber per county') || html.includes('one subscriber per county'), 'Home: missing exclusivity messaging');

console.log('PASS: home.test.js');
