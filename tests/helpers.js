const fs = require('fs');
const path = require('path');

const NAV_LINKS = [
  ['index.html', 'Home'],
  ['how-it-works.html', 'How it works'],
  ['pricing.html', 'Pricing'],
  ['faq.html', 'FAQ'],
  ['contact.html', 'Contact'],
];

function readPage(filename) {
  return fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error('ASSERTION FAILED: ' + message);
}

function assertCommonChrome(html, pageLabel) {
  assert(html.includes('<html lang="en">'), `${pageLabel}: missing lang attribute`);
  for (const [href, label] of NAV_LINKS) {
    assert(html.includes(`href="${href}"`), `${pageLabel}: nav missing link to ${href}`);
    assert(html.includes(label), `${pageLabel}: nav missing label "${label}"`);
  }
  assert(html.includes('href="mailto:hello@venturesdatasolutions.com"'), `${pageLabel}: footer missing mailto link`);
  assert(html.includes('[ phone number coming soon ]'), `${pageLabel}: footer missing phone placeholder text`);
  assert(!html.includes('href="tel:'), `${pageLabel}: page must not contain a live tel: link`);
  assert(html.includes('href="assets/styles.css"'), `${pageLabel}: missing stylesheet link`);
  assert(html.includes('href="assets/vds-icon.png"') && html.includes('rel="icon"'), `${pageLabel}: missing favicon link`);
  assert(html.includes('href="terms.html"'), `${pageLabel}: footer missing Terms link`);
  assert(html.includes('href="privacy.html"'), `${pageLabel}: footer missing Privacy link`);
  assert(html.includes('<title>'), `${pageLabel}: missing title tag`);
}

module.exports = { readPage, assert, assertCommonChrome, NAV_LINKS };
