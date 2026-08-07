// tests/counties.test.js
const fs = require('fs');
const path = require('path');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const root = path.join(__dirname, '..');
const assetsPath = path.join(root, 'assets', 'counties.json');
const workerPath = path.join(root, 'worker', 'data', 'counties.json');

assert(fs.existsSync(assetsPath), 'assets/counties.json missing — run `node scripts/build-counties.js`');
assert(fs.existsSync(workerPath), 'worker/data/counties.json missing — run `node scripts/build-counties.js`');

const assetsJson = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
const workerJson = JSON.parse(fs.readFileSync(workerPath, 'utf8'));

assert(Array.isArray(assetsJson), 'assets/counties.json must be an array');
assert(assetsJson.length === 3143, `expected 3143 counties, got ${assetsJson.length}`);
assert(JSON.stringify(assetsJson) === JSON.stringify(workerJson), 'assets/counties.json and worker/data/counties.json must be byte-identical');

const ids = new Set();
for (const county of assetsJson) {
  assert(typeof county.id === 'string' && /^\d{5}$/.test(county.id), `county id must be a 5-digit FIPS string, got ${JSON.stringify(county.id)}`);
  assert(typeof county.name === 'string' && county.name.length > 0, `county missing name for id ${county.id}`);
  assert(typeof county.state === 'string' && /^[A-Z]{2}$/.test(county.state), `county missing valid 2-letter state for id ${county.id}`);
  assert(!ids.has(county.id), `duplicate county id ${county.id}`);
  ids.add(county.id);
}

const sample = assetsJson.find((c) => c.id === '01001');
assert(sample && sample.name === 'Autauga County' && sample.state === 'AL', 'expected Autauga County, AL at FIPS 01001');

console.log('PASS: counties.test.js');
