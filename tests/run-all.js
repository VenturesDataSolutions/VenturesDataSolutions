const files = [
  './assets.test.js',
  './counties.test.js',
  './home.test.js',
  './how-it-works.test.js',
  './county-data.test.js',
  './platform.test.js',
  './investors.test.js',
  './agents.test.js',
  './purchase.test.js',
  './purchase-success.test.js',
  './faq.test.js',
  './what-we-do.test.js',
  './contact.test.js',
  './terms.test.js',
  './privacy.test.js',
];

for (const f of files) {
  require(f);
}
console.log('ALL PAGE TESTS PASSED');
