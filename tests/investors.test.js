const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('investors.html');
assertCommonChrome(html, 'Investors');

// Three tiers, each with setup fee + care plan pricing
assert(/Starter/.test(html), 'Investors: missing Starter tier');
assert(/Core/.test(html), 'Investors: missing Core tier');
assert(/Full Investor Platform/.test(html), 'Investors: missing Full Investor Platform tier');
assert(html.includes('$800') && html.includes('$1,200'), 'Investors: missing Starter setup fee range');
assert(html.includes('$100') && html.includes('$150'), 'Investors: missing Starter care plan range');
assert(html.includes('$1,800') && html.includes('$2,800'), 'Investors: missing Core setup fee range');
assert(html.includes('$250') && html.includes('$400'), 'Investors: missing Core care plan range');
assert(html.includes('$2,800') && html.includes('$4,500'), 'Investors: missing Full Platform setup fee range');
assert(html.includes('$350') && html.includes('$650'), 'Investors: missing Full Platform care plan range');

// Feature callouts required by spec
assert(/job-cost/i.test(html), 'Investors: missing job-cost tracker language');
assert(/tax-category rollup/i.test(html), 'Investors: missing tax-category rollup feature');
assert(/deed-transfer|deed transfer/i.test(html), 'Investors: missing deed-transfer research feature');
assert(/comparable-sale|comps/i.test(html), 'Investors: missing comps/comparable-sale feature');

// Illustrative framing, not a guarantee
assert(/ten thousand dollars/i.test(html), 'Investors: missing illustrative deal-profit framing');
assert(/not a promise/i.test(html), 'Investors: framing statement must be explicitly non-guarantee');

// Unstructured data callout
assert(/handwritten notes/i.test(html), 'Investors: missing unstructured-data handling callout');

// Wording safety: must not claim the platform includes/bundles exclusive county leads
assert(!/includes.{0,40}county.{0,20}lead/i.test(html), 'Investors: must not word county leads as included in the platform');
assert(/integrates with your county/i.test(html), 'Investors: Full Platform tier must use "integrates with your county..." wording, not an inclusion claim');
assert(/public property records|public county auditor/i.test(html), 'Investors: missing general-public-records distinction for research/comps');

console.log('PASS: investors.test.js');
