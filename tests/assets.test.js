// tests/assets.test.js
const fs = require('fs');
const path = require('path');

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const tokens = ['--cream', '--forest', '--forest-dark', '--stamp-red', '--gold', '--ink'];
for (const token of tokens) {
  assert(css.includes(token), `styles.css missing brand token ${token}`);
}

assert(fs.existsSync(path.join(root, 'assets', 'vds-logo.png')), 'assets/vds-logo.png missing');
assert(fs.existsSync(path.join(root, 'assets', 'vds-icon.png')), 'assets/vds-icon.png missing');

const cname = fs.readFileSync(path.join(root, 'CNAME'), 'utf8').trim();
assert(cname === 'venturesdatasolutions.com', `CNAME should be venturesdatasolutions.com, got "${cname}"`);

const workerReadme = fs.readFileSync(path.join(root, 'worker', 'README.md'), 'utf8');
assert(workerReadme.includes('wrangler'), 'worker/README.md should mention wrangler');
assert(workerReadme.includes('wrangler deploy'), 'worker/README.md should document how to deploy the now-implemented Worker');
assert(!/not yet implemented|not built yet/i.test(workerReadme), 'worker/README.md should no longer mark itself as not yet implemented, now that the Worker backend is built');

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert(readme.includes('worker/'), 'README.md should reference the worker/ folder');
assert(/GitHub Pages/i.test(readme), 'README.md should document GitHub Pages deploy');

console.log('PASS: assets.test.js');
