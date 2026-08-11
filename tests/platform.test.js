const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('platform.html');
assertCommonChrome(html, 'Platform');
assert(html.includes('href="investors.html"'), 'Platform: missing link into Investors');
assert(html.includes('href="agents.html"'), 'Platform: missing link into Agents');
assert(html.includes('href="county-data.html"'), 'Platform: missing link into County Data');
assert(/For Investors/.test(html), 'Platform: missing Investors labeling');
assert(/For Agents/.test(html), 'Platform: missing Agents labeling');

console.log('PASS: platform.test.js');
