const files = [
  './assets.test.js',
  './counties.test.js',
  './home.test.js',
  './how-it-works.test.js',
  './pricing.test.js',
  './purchase.test.js',
  './purchase-success.test.js',
  './faq.test.js',
  './contact.test.js',
  './terms.test.js',
  './privacy.test.js',
];

for (const f of files) {
  require(f);
}
console.log('ALL PAGE TESTS PASSED');
