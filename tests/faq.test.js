const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('faq.html');
assertCommonChrome(html, 'FAQ');
const questions = [
  'What happens if I cancel',
  'Can someone else buy my county',
  'How fresh is',
  'included in a pull',
  'Is there a contract',
];
for (const q of questions) {
  assert(html.includes(q), `FAQ: missing question containing "${q}"`);
}

console.log('PASS: faq.test.js');
