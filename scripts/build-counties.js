// scripts/build-counties.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const SOURCE_URL = 'https://www2.census.gov/geo/docs/reference/codes/national_county.txt';
const TERRITORY_CODES = new Set(['AS', 'GU', 'MP', 'PR', 'UM', 'VI']);

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Request to ${url} failed: HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCounties(text) {
  const lines = text.trim().split('\n').slice(1); // drop header row
  const counties = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length !== 5) {
      throw new Error(`Unexpected row shape (expected 5 comma-separated fields, got ${parts.length}): ${line}`);
    }
    const [state, stateAnsi, countyAnsi, countyName] = parts;
    if (TERRITORY_CODES.has(state)) continue;
    counties.push({
      id: `${stateAnsi}${countyAnsi}`,
      name: countyName.trim(),
      state: state.trim(),
    });
  }
  return counties;
}

async function main() {
  const text = await fetchText(SOURCE_URL);
  const counties = parseCounties(text);
  if (counties.length !== 3143) {
    throw new Error(`Expected 3143 counties after filtering territories, got ${counties.length}. Census source format may have changed — check ${SOURCE_URL}`);
  }
  const json = JSON.stringify(counties, null, 2);

  const assetsPath = path.join(__dirname, '..', 'assets', 'counties.json');
  const workerPath = path.join(__dirname, '..', 'worker', 'data', 'counties.json');
  fs.mkdirSync(path.dirname(assetsPath), { recursive: true });
  fs.mkdirSync(path.dirname(workerPath), { recursive: true });
  fs.writeFileSync(assetsPath, json);
  fs.writeFileSync(workerPath, json);

  console.log(`Wrote ${counties.length} counties to assets/counties.json and worker/data/counties.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
