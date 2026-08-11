const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('index.html');
assertCommonChrome(html, 'Home');
assert(html.includes('href="platform.html"'), 'Home: missing link into Platform');
assert(html.includes('href="investors.html"'), 'Home: missing link into Investors');
assert(html.includes('href="agents.html"'), 'Home: missing link into Agents');
assert(html.includes('href="county-data.html"'), 'Home: missing link into County Data');
assert(html.includes('Ventures Data Solutions builds automation and data-processing systems for real estate investors and agents'), 'Home: missing required lead value-proposition sentence');

const heroMatch = html.match(/<section class="hero container">[\s\S]*?<\/section>/);
assert(heroMatch, 'Home: missing hero section');
assert(!/county/i.test(heroMatch[0]), 'Home: hero section must not lead with county data language');

console.log('PASS: home.test.js');
