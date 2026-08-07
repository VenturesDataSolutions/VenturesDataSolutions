# VDS Static Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 8-page VDS static marketing/purchase site (no backend) as plain HTML/CSS, deployable to GitHub Pages, matching the approved spec at `docs/superpowers/specs/2026-08-07-static-site-design.md`.

**Architecture:** Flat `.html` files at repo root, one shared `assets/styles.css` for all brand/layout CSS, identical nav/header/footer markup duplicated into every page (no build step, no framework). A `worker/` folder is scaffolded now as a placeholder for the Stripe/Cloudflare Worker backend that will be designed and built in a separate later round.

**Tech Stack:** Plain HTML5, CSS (custom properties, no preprocessor), Google Fonts CDN (Fraunces, Inter, IBM Plex Mono). No JS on the pages themselves. Verification uses plain Node.js scripts (built-in `fs`/`assert` only, zero npm dependencies) that check structural requirements in each generated page.

---

## Shared reference: header/nav and footer markup

Every page task below embeds this exact block (with `aria-current="page"` moved to whichever nav link matches the current page). This section is here once so the pattern is clear — each task still shows the full HTML it writes.

```html
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>
```

```html
<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
```

Shared `<head>` block every page includes:

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
```

---

### Task 1: Brand assets, styles, and repo scaffolding

**Files:**
- Create: `assets/styles.css`
- Create: `assets/vds-logo.png` (copy of existing repo-root `vds-logo.png`)
- Create: `assets/vds-icon.png` (copy of existing repo-root `vds-icon.png`)
- Create: `CNAME`
- Create: `worker/README.md`
- Create: `README.md`
- Test: `tests/assets.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
assert(/not yet implemented|not built yet/i.test(workerReadme), 'worker/README.md should mark itself as not yet implemented');

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert(readme.includes('worker/'), 'README.md should reference the worker/ folder');
assert(/GitHub Pages/i.test(readme), 'README.md should document GitHub Pages deploy');

console.log('PASS: assets.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/assets.test.js`
Expected: throws `Error: ENOENT: no such file or directory, open '...assets/styles.css'` (or similar — files don't exist yet).

- [ ] **Step 3: Copy the logo assets into `assets/`**

```bash
mkdir -p assets
cp vds-logo.png assets/vds-logo.png
cp vds-icon.png assets/vds-icon.png
```

- [ ] **Step 4: Write `assets/styles.css`**

```css
:root {
  --cream: #F5F0E1;
  --forest: #2E4736;
  --forest-dark: #1E2F25;
  --stamp-red: #A8382C;
  --gold: #B98F3B;
  --ink: #1C2620;
  --line: rgba(28, 38, 32, 0.16);
  --max-width: 1080px;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--cream);
  color: var(--ink);
  font-family: 'Inter', sans-serif;
  line-height: 1.5;
}

h1, h2, h3 {
  font-family: 'Fraunces', serif;
  font-weight: 700;
  line-height: 1.1;
  margin: 0 0 0.5em;
  color: var(--forest);
}

p { margin: 0 0 1em; }

a { color: inherit; }

.eyebrow {
  display: block;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--gold);
  margin-bottom: 12px;
}

.container {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 24px;
}

/* Header */
.site-header {
  background: var(--cream);
  border-bottom: 1px solid var(--line);
}
.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 18px;
  padding-bottom: 18px;
  flex-wrap: wrap;
  gap: 16px;
}
.brand-logo { height: 36px; display: block; }
.site-nav { display: flex; gap: 24px; flex-wrap: wrap; }
.site-nav a {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--forest);
  padding-bottom: 2px;
  border-bottom: 2px solid transparent;
}
.site-nav a:hover,
.site-nav a[aria-current="page"] {
  border-bottom-color: var(--stamp-red);
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  text-decoration: none;
  padding: 13px 22px;
  border: none;
  border-radius: 2px;
  cursor: pointer;
}
.btn-primary { background: var(--stamp-red); color: var(--cream); }
.btn-primary:hover { background: #8f2f24; }
.btn-secondary { background: transparent; color: var(--forest); border: 1px solid var(--forest); }
.btn-primary[aria-disabled="true"] {
  background: var(--line);
  color: var(--ink);
  opacity: 0.6;
  cursor: not-allowed;
  pointer-events: none;
}

/* Hero */
.hero { padding: 96px 0 72px; }
.hero h1 { font-size: clamp(36px, 6vw, 64px); }
.hero p.lede { font-size: 18px; max-width: 560px; }
.hero .actions { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 32px; }

/* Sections */
.section { padding: 64px 0; }
.section-alt { background: #ECE4CC; }
.section h2 { font-size: clamp(28px, 4vw, 40px); }

/* Cards */
.card {
  background: var(--cream);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 28px;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 24px;
  margin-top: 32px;
}

/* Badges */
.badge {
  display: inline-block;
  background: var(--stamp-red);
  color: var(--cream);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 4px 10px;
}

/* Pricing */
.price-card {
  background: var(--forest);
  color: var(--cream);
  border-radius: 4px;
  padding: 40px;
  max-width: 420px;
}
.price-card .amount { font-family: 'Fraunces', serif; font-weight: 800; font-size: 56px; color: var(--gold); }
.price-card .amount .unit { font-family: 'IBM Plex Mono', monospace; font-size: 16px; color: rgba(245,240,225,0.6); }

/* FAQ */
.faq-item { border-bottom: 1px solid var(--line); padding: 24px 0; }
.faq-item h3 { font-size: 20px; margin-bottom: 8px; }

/* Draft banner (Terms/Privacy) */
.draft-banner {
  background: var(--stamp-red);
  color: var(--cream);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
  letter-spacing: 0.04em;
  padding: 14px 0;
  text-align: center;
}

/* Footer */
.site-footer { background: var(--forest-dark); color: var(--cream); margin-top: 64px; }
.footer-inner { display: flex; flex-wrap: wrap; align-items: center; gap: 24px; padding: 40px 24px; }
.footer-icon { height: 32px; width: auto; }
.footer-meta a { color: var(--cream); text-decoration: underline; }
.footer-phone-placeholder { opacity: 0.6; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
.footer-legal { display: flex; gap: 16px; margin-left: auto; }
.footer-legal a { font-family: 'IBM Plex Mono', monospace; font-size: 12px; text-decoration: none; color: var(--cream); opacity: 0.8; }
.footer-copyright { width: 100%; font-size: 12px; opacity: 0.5; margin-top: 8px; }

@media (max-width: 640px) {
  .footer-legal { margin-left: 0; }
}
```

- [ ] **Step 5: Write `CNAME`**

```
venturesdatasolutions.com
```

- [ ] **Step 6: Write `worker/README.md`**

```markdown
# VDS Cloudflare Worker

This folder will hold the Cloudflare Worker source code that powers county-availability checks, Stripe Checkout session creation, and Stripe webhook handling (subscription created → lock county in Workers KV; subscription canceled → unlock county).

**Status:** Not yet implemented. This is a placeholder for a separate design/build round — see `docs/superpowers/specs/` for the static-site spec that shipped first.

**Deploys separately from the static site** via `wrangler`, not via GitHub Pages. When the Worker is built, this file will be replaced with real deploy instructions (`wrangler deploy`, `wrangler secret put STRIPE_SECRET_KEY`, etc.).
```

- [ ] **Step 7: Write root `README.md`**

```markdown
# Venture$ Data Solutions — Website

Static marketing + purchase site for Venture$ Data Solutions (VDS).

## What's here

- Root-level `.html` files — the static site (Home, How It Works, Pricing, Purchase, FAQ, Contact, Terms, Privacy).
- `assets/` — brand assets (logo, icon, `styles.css`).
- `worker/` — Cloudflare Worker source for the Stripe + county-lock backend. **Not built yet** — see `worker/README.md`. Deploys separately from the static site, via `wrangler`, not GitHub Pages.
- `tests/` — plain Node scripts (no dependencies) that check every page has the required nav, footer, and safety guarantees (e.g. no live `tel:` link before a real phone number exists). Run with `node tests/run-all.js`.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and implementation plans for this project.

## Deploying the static site (GitHub Pages)

1. Push to the `main` branch of this repo.
2. In GitHub repo Settings → Pages, set the source to `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. The `CNAME` file in this repo already points GitHub Pages at `venturesdatasolutions.com`. DNS for that domain is managed in Cloudflare — confirm a `CNAME`/`A` record there points at GitHub Pages per GitHub's custom domain docs.
4. No build step — GitHub Pages serves the `.html`/`assets/` files as-is.

## Deploying the Cloudflare Worker (separate, future)

The Worker in `worker/` is deployed independently of the static site, using `wrangler` from within the `worker/` folder (`wrangler deploy`). Stripe secret keys and webhook signing secrets are set as Worker secrets (`wrangler secret put STRIPE_SECRET_KEY`), never committed to this repo. See `worker/README.md` for current status.

## Running the page tests locally

```
node tests/run-all.js
```

This checks structural requirements only (nav/footer present, no live phone link, etc.) — it does not replace opening the pages in a browser to check visual layout.
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node tests/assets.test.js`
Expected: `PASS: assets.test.js`

- [ ] **Step 9: Commit**

```bash
git add assets/ CNAME worker/README.md README.md tests/assets.test.js
git commit -m "Add brand assets, shared styles, and repo scaffolding"
```

---

### Task 2: Shared test helper

**Files:**
- Create: `tests/helpers.js`

- [ ] **Step 1: Write `tests/helpers.js`**

```js
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
```

- [ ] **Step 2: Sanity-check it loads**

Run: `node -e "require('./tests/helpers.js'); console.log('helpers OK')"`
Expected: `helpers OK`

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.js
git commit -m "Add shared page-chrome test helper"
```

---

### Task 3: Home page

**Files:**
- Create: `index.html`
- Test: `tests/home.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/home.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('index.html');
assertCommonChrome(html, 'Home');
assert(html.includes('href="pricing.html"'), 'Home: missing link into Pricing');
assert(html.includes('href="how-it-works.html"'), 'Home: missing link into How It Works');
assert(html.includes('One subscriber per county') || html.includes('one subscriber per county'), 'Home: missing exclusivity messaging');

console.log('PASS: home.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/home.test.js`
Expected: throws ENOENT (`index.html` doesn't exist yet).

- [ ] **Step 3: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Venture$ Data Solutions — Exclusive county tax &amp; probate data</title>
<meta name="description" content="One subscriber per county. Fresh tax delinquency and probate data, parsed and delivered in 24 hours. $150/mo, cancel anytime.">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html" aria-current="page">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero container">
    <span class="eyebrow">VDS — Tax &amp; probate data</span>
    <h1>Your county. Nobody else&rsquo;s.</h1>
    <p class="lede">We pull tax delinquency and probate records, parse them clean, and deliver your county&rsquo;s list in 24 hours &mdash; exclusively yours for as long as you&rsquo;re subscribed.</p>
    <div class="actions">
      <a href="pricing.html" class="btn btn-primary">See pricing</a>
      <a href="how-it-works.html" class="btn btn-secondary">How it works</a>
    </div>
  </section>

  <section class="section section-alt">
    <div class="container">
      <span class="eyebrow">Why VDS</span>
      <h2>Fresh data. One subscriber per county. No games.</h2>
      <div class="card-grid">
        <div class="card">
          <h3>Fresh</h3>
          <p>Pulled and parsed within 24 hours &mdash; not sitting on a shelf for a month before it reaches you.</p>
        </div>
        <div class="card">
          <h3>Exclusive</h3>
          <p>One subscriber per county. We don&rsquo;t sell your county to anyone else while you&rsquo;re subscribed.</p>
        </div>
        <div class="card">
          <h3>Honest</h3>
          <p>Cancel anytime. No fees, no penalty &mdash; you just lose the county.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="container">
      <h2>Ready to claim your county?</h2>
      <p class="lede">Founding-rate pricing is available now, before we&rsquo;re full.</p>
      <a href="purchase.html" class="btn btn-primary">Claim your county</a>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/home.test.js`
Expected: `PASS: home.test.js`

- [ ] **Step 5: Commit**

```bash
git add index.html tests/home.test.js
git commit -m "Add Home page"
```

---

### Task 4: How It Works page

**Files:**
- Create: `how-it-works.html`
- Test: `tests/how-it-works.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/how-it-works.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('how-it-works.html');
assertCommonChrome(html, 'How It Works');
assert(html.includes('Pull'), 'How It Works: missing Pull step');
assert(html.includes('Parse'), 'How It Works: missing Parse step');
assert(html.includes('Deliver'), 'How It Works: missing Deliver step');
assert(/one subscriber per county/i.test(html), 'How It Works: missing plain-language exclusivity explanation');
assert(html.includes('href="pricing.html"'), 'How It Works: missing link into Pricing');

console.log('PASS: how-it-works.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/how-it-works.test.js`
Expected: ENOENT — `how-it-works.html` doesn't exist yet.

- [ ] **Step 3: Write `how-it-works.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>How it works — Venture$ Data Solutions</title>
<meta name="description" content="How VDS pulls, parses, and delivers county tax delinquency and probate data — and what one subscriber per county actually means.">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html" aria-current="page">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero container">
    <span class="eyebrow">Process</span>
    <h1>Pull. Parse. Deliver.</h1>
    <p class="lede">No dashboards to log into, no stale exports. Just your county&rsquo;s tax delinquency and probate list, landing in your inbox.</p>
  </section>

  <section class="section section-alt">
    <div class="container">
      <div class="card-grid">
        <div class="card">
          <span class="badge">01</span>
          <h3>Pull</h3>
          <p>We pull tax delinquency and probate records directly from your county&rsquo;s public sources.</p>
        </div>
        <div class="card">
          <span class="badge">02</span>
          <h3>Parse</h3>
          <p>Raw records get cleaned and structured into one usable list &mdash; no duplicate entries, no formatting mess.</p>
        </div>
        <div class="card">
          <span class="badge">03</span>
          <h3>Deliver</h3>
          <p>Your list lands in your inbox within 24 hours of the pull.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="container">
      <h2>What &ldquo;one subscriber per county&rdquo; means</h2>
      <p class="lede">When you subscribe to a county, that county is locked to you. We do not sell the same county&rsquo;s list to another buyer while you&rsquo;re an active subscriber &mdash; you&rsquo;re the only one getting it. If you ever cancel, that county goes back into the pool and becomes available to someone else. There&rsquo;s no bidding war and no surprise competitor buying in behind you.</p>
      <a href="pricing.html" class="btn btn-primary">See pricing</a>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/how-it-works.test.js`
Expected: `PASS: how-it-works.test.js`

- [ ] **Step 5: Commit**

```bash
git add how-it-works.html tests/how-it-works.test.js
git commit -m "Add How It Works page"
```

---

### Task 5: Pricing page

**Files:**
- Create: `pricing.html`
- Test: `tests/pricing.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/pricing.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('pricing.html');
assertCommonChrome(html, 'Pricing');
assert(html.includes('$150'), 'Pricing: missing $150/mo price');
assert(html.includes('$300'), 'Pricing: missing $300 first-month-once-full framing');
assert(/cancel anytime/i.test(html), 'Pricing: missing cancel-anytime messaging');
assert(/no fee/i.test(html), 'Pricing: missing no-fee messaging');
assert(html.includes('href="purchase.html"'), 'Pricing: missing CTA link into Purchase');

console.log('PASS: pricing.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/pricing.test.js`
Expected: ENOENT — `pricing.html` doesn't exist yet.

- [ ] **Step 3: Write `pricing.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pricing — Venture$ Data Solutions</title>
<meta name="description" content="$150/mo for exclusive access to your county's tax delinquency and probate data. Founding rate, cancel anytime, no fees.">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html" aria-current="page">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero container">
    <span class="eyebrow">Pricing</span>
    <h1>One price. One county.</h1>
    <p class="lede">Simple, flat, and the same whether you sign up today or next year.</p>
  </section>

  <section class="section section-alt">
    <div class="container">
      <div class="price-card">
        <span class="badge">Founding rate</span>
        <p class="amount">$150<span class="unit">/mo</span></p>
        <p>Locked in for as long as you stay subscribed to your county.</p>
      </div>
      <p style="margin-top:24px; max-width:640px;">Founding-rate subscribers pay $150/mo, full stop. Once VDS is full, new counties open at $300 for the first month &mdash; then drop to the same $150/mo ongoing rate every founding subscriber already has.</p>
    </div>
  </section>

  <section class="section">
    <div class="container">
      <h2>What&rsquo;s included</h2>
      <div class="card-grid">
        <div class="card">
          <h3>Your county, exclusively</h3>
          <p>One subscriber per county. We don&rsquo;t sell your county to anyone else while you&rsquo;re subscribed.</p>
        </div>
        <div class="card">
          <h3>A fresh pull every cycle</h3>
          <p>Tax delinquency and probate records pulled, parsed, and delivered on a regular schedule.</p>
        </div>
        <div class="card">
          <h3>Cancel anytime</h3>
          <p>No fees, no penalty &mdash; you just lose the county. No contract, no minimum commitment.</p>
        </div>
      </div>
      <p style="margin-top:32px;"><a href="purchase.html" class="btn btn-primary">Claim your county</a></p>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/pricing.test.js`
Expected: `PASS: pricing.test.js`

- [ ] **Step 5: Commit**

```bash
git add pricing.html tests/pricing.test.js
git commit -m "Add Pricing page"
```

---

### Task 6: Purchase page (adapted from flyer.html, button disabled)

**Files:**
- Create: `purchase.html`
- Test: `tests/purchase.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/purchase.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('purchase.html');
assertCommonChrome(html, 'Purchase');
assert(html.includes('aria-disabled="true"'), 'Purchase: Claim button must be marked aria-disabled="true"');
assert(/coming soon/i.test(html), 'Purchase: missing a visible "coming soon" state on the disabled button');
assert(!html.includes('<form'), 'Purchase: must not contain a live form until the backend round');
assert(!/onclick\s*=/.test(html), 'Purchase: must not contain inline onclick handlers pretending to submit/checkout');
assert(html.includes('$150'), 'Purchase: missing price');
assert(html.includes('mailto:hello@venturesdatasolutions.com'), 'Purchase: missing fallback email contact for claiming a county now');

console.log('PASS: purchase.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/purchase.test.js`
Expected: ENOENT — `purchase.html` doesn't exist yet.

- [ ] **Step 3: Write `purchase.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claim your county — Venture$ Data Solutions</title>
<meta name="description" content="Claim exclusive access to your county's tax delinquency and probate data for $150/mo. Online checkout is launching shortly.">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="section">
    <div class="container" style="max-width:560px;">
      <span class="badge">1 buyer / county</span>
      <h1 style="margin-top:16px;">Claim your county.</h1>
      <p class="lede">Your county, exclusively. We never sell it to anyone else while you&rsquo;re subscribed &mdash; cancel anytime, no fees.</p>
      <div class="price-card" style="margin:24px 0;">
        <span class="badge">Founding rate</span>
        <p class="amount">$150<span class="unit">/mo</span></p>
      </div>
      <button type="button" class="btn btn-primary" aria-disabled="true" disabled>Claim your county &mdash; coming soon</button>
      <p style="margin-top:16px;">Online checkout is launching shortly. In the meantime, email <a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a> with your county to claim it now.</p>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/purchase.test.js`
Expected: `PASS: purchase.test.js`

- [ ] **Step 5: Commit**

```bash
git add purchase.html tests/purchase.test.js
git commit -m "Add Purchase page with disabled claim button"
```

---

### Task 7: FAQ page

**Files:**
- Create: `faq.html`
- Test: `tests/faq.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/faq.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/faq.test.js`
Expected: ENOENT — `faq.html` doesn't exist yet.

- [ ] **Step 3: Write `faq.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FAQ — Venture$ Data Solutions</title>
<meta name="description" content="Answers on cancellation, county exclusivity, data freshness, and what's included in a VDS subscription.">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html" aria-current="page">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero container">
    <span class="eyebrow">FAQ</span>
    <h1>Questions, answered plainly.</h1>
  </section>

  <section class="section">
    <div class="container" style="max-width:720px;">
      <div class="faq-item">
        <h3>What happens if I cancel?</h3>
        <p>Your subscription ends, you stop being billed, and your county goes back into the pool for someone else to claim. No fees, no penalty.</p>
      </div>
      <div class="faq-item">
        <h3>Can someone else buy my county while I&rsquo;m subscribed?</h3>
        <p>No. One subscriber per county is a hard rule &mdash; we don&rsquo;t sell your county to anyone else while your subscription is active.</p>
      </div>
      <div class="faq-item">
        <h3>How fresh is &ldquo;fresh&rdquo;?</h3>
        <p>We pull records on a regular schedule and deliver your parsed list within 24 hours of the pull &mdash; not a stale export sitting around for weeks.</p>
      </div>
      <div class="faq-item">
        <h3>What&rsquo;s included in a pull?</h3>
        <p>Tax delinquency and probate records for your county, cleaned and structured into one usable list.</p>
      </div>
      <div class="faq-item">
        <h3>Is there a contract or commitment?</h3>
        <p>No. It&rsquo;s a month-to-month subscription. Cancel anytime, no fees.</p>
      </div>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/faq.test.js`
Expected: `PASS: faq.test.js`

- [ ] **Step 5: Commit**

```bash
git add faq.html tests/faq.test.js
git commit -m "Add FAQ page"
```

---

### Task 8: Contact page

**Files:**
- Create: `contact.html`
- Test: `tests/contact.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/contact.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('contact.html');
assertCommonChrome(html, 'Contact');

// The phone placeholder must be plain text, not wrapped in a live link of any kind.
const phoneLineMatch = html.match(/<[^>]*>\[ phone number coming soon \]<\/[^>]*>/);
assert(phoneLineMatch, 'Contact: phone placeholder should be in a plain text element');
assert(!/<a[^>]*>\s*\[ phone number coming soon \]/.test(html), 'Contact: phone placeholder must not be wrapped in an <a> tag');

console.log('PASS: contact.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/contact.test.js`
Expected: ENOENT — `contact.html` doesn't exist yet.

- [ ] **Step 3: Write `contact.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Contact — Venture$ Data Solutions</title>
<meta name="description" content="Get in touch with Venture$ Data Solutions.">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html" aria-current="page">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero container">
    <span class="eyebrow">Contact</span>
    <h1>Get in touch.</h1>
    <p class="lede">Questions about a county, pricing, or anything else &mdash; email us and we&rsquo;ll get back to you.</p>
    <div class="actions">
      <a href="mailto:hello@venturesdatasolutions.com" class="btn btn-primary">hello@venturesdatasolutions.com</a>
    </div>
    <p style="margin-top:24px;" class="footer-phone-placeholder">[ phone number coming soon ]</p>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/contact.test.js`
Expected: `PASS: contact.test.js`

- [ ] **Step 5: Commit**

```bash
git add contact.html tests/contact.test.js
git commit -m "Add Contact page"
```

---

### Task 9: Terms of Service page (draft)

**Files:**
- Create: `terms.html`
- Test: `tests/terms.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/terms.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('terms.html');
assertCommonChrome(html, 'Terms');
assert(/draft-banner/.test(html), 'Terms: missing visible draft banner element');
assert(/pending legal review/i.test(html), 'Terms: draft banner must say it is pending legal review');
assert(/recurring/i.test(html), 'Terms: missing recurring-subscription language');
assert(/cancel/i.test(html) && /any time|anytime/i.test(html), 'Terms: missing cancel-anytime language');
assert(/no fee|no penalt/i.test(html), 'Terms: missing no-fees/no-penalty language');

console.log('PASS: terms.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/terms.test.js`
Expected: ENOENT — `terms.html` doesn't exist yet.

- [ ] **Step 3: Write `terms.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Terms of Service — Venture$ Data Solutions</title>
<meta name="description" content="Terms of Service for Venture$ Data Solutions (draft, pending legal review).">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<div class="draft-banner">DRAFT &mdash; pending legal review. Not final legal advice.</div>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="section container" style="max-width:720px;">
    <h1>Terms of Service</h1>
    <p>Last updated: August 7, 2026.</p>
    <p>These Terms of Service govern your subscription to Venture$ Data Solutions (&ldquo;VDS,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;). By subscribing, you agree to the terms below.</p>
    <h2>Subscription and billing</h2>
    <p>A VDS subscription is a recurring monthly charge tied to one county. You are billed on the same date each month for as long as your subscription remains active.</p>
    <h2>Cancellation</h2>
    <p>You may cancel your subscription at any time. Cancellation takes effect at the end of your current billing period, with no cancellation fees and no penalties. Once canceled, your county becomes available for another subscriber to claim.</p>
    <h2>Use of data</h2>
    <p>Data delivered through your subscription is for your own business use. Reselling or redistributing your county&rsquo;s data to third parties is not permitted under these terms.</p>
    <h2>Changes to these terms</h2>
    <p>We may update these terms from time to time. Continued use of the service after an update constitutes acceptance of the revised terms.</p>
    <h2>Contact</h2>
    <p>Questions about these terms can be sent to <a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a>.</p>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/terms.test.js`
Expected: `PASS: terms.test.js`

- [ ] **Step 5: Commit**

```bash
git add terms.html tests/terms.test.js
git commit -m "Add Terms of Service draft page"
```

---

### Task 10: Privacy Policy page (draft)

**Files:**
- Create: `privacy.html`
- Test: `tests/privacy.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/privacy.test.js
const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('privacy.html');
assertCommonChrome(html, 'Privacy');
assert(/draft-banner/.test(html), 'Privacy: missing visible draft banner element');
assert(/pending legal review/i.test(html), 'Privacy: draft banner must say it is pending legal review');
assert(/no.*resale|do not sell/i.test(html), 'Privacy: missing no-data-resale statement');
assert(html.includes('Stripe'), 'Privacy: should mention Stripe as a payment data collection point (even though checkout is not live yet)');

console.log('PASS: privacy.test.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/privacy.test.js`
Expected: ENOENT — `privacy.html` doesn't exist yet.

- [ ] **Step 3: Write `privacy.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy — Venture$ Data Solutions</title>
<meta name="description" content="Privacy Policy for Venture$ Data Solutions (draft, pending legal review).">
<link rel="icon" type="image/png" href="assets/vds-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<div class="draft-banner">DRAFT &mdash; pending legal review. Not final legal advice.</div>
<header class="site-header">
  <div class="container header-inner">
    <a href="index.html" class="brand"><img src="assets/vds-logo.png" alt="Venture$ Data Solutions" class="brand-logo"></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="index.html">Home</a>
      <a href="how-it-works.html">How it works</a>
      <a href="pricing.html">Pricing</a>
      <a href="faq.html">FAQ</a>
      <a href="contact.html">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="section container" style="max-width:720px;">
    <h1>Privacy Policy</h1>
    <p>Last updated: August 7, 2026.</p>
    <p>This policy describes what information Venture$ Data Solutions (&ldquo;VDS&rdquo;) collects through this website and how it&rsquo;s used.</p>
    <h2>What we collect</h2>
    <p>When you contact us or subscribe, we collect the information you provide directly (such as your email address) and, once online checkout is live, payment and billing information processed by our payment provider, Stripe. We do not directly store your full payment card details &mdash; Stripe handles that.</p>
    <h2>How we use it</h2>
    <p>Information you provide is used to deliver your subscription, respond to your questions, and manage billing. We do not sell or rent your information to third parties.</p>
    <h2>Data retention</h2>
    <p>We keep account and billing information for as long as needed to provide the service and meet legal or accounting obligations.</p>
    <h2>Contact</h2>
    <p>Questions about this policy can be sent to <a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a>.</p>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <img src="assets/vds-icon.png" alt="" class="footer-icon">
    <div class="footer-meta">
      <p class="footer-brand">Venture$ Data Solutions</p>
      <p><a href="mailto:hello@venturesdatasolutions.com">hello@venturesdatasolutions.com</a></p>
      <p class="footer-phone-placeholder">[ phone number coming soon ]</p>
    </div>
    <div class="footer-legal">
      <a href="terms.html">Terms of Service</a>
      <a href="privacy.html">Privacy Policy</a>
    </div>
    <p class="footer-copyright">&copy; 2026 Venture$ Data Solutions. All rights reserved.</p>
  </div>
</footer>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/privacy.test.js`
Expected: `PASS: privacy.test.js`

- [ ] **Step 5: Commit**

```bash
git add privacy.html tests/privacy.test.js
git commit -m "Add Privacy Policy draft page"
```

---

### Task 11: Full test runner and manual browser verification

**Files:**
- Create: `tests/run-all.js`

- [ ] **Step 1: Write `tests/run-all.js`**

```js
const files = [
  './assets.test.js',
  './home.test.js',
  './how-it-works.test.js',
  './pricing.test.js',
  './purchase.test.js',
  './faq.test.js',
  './contact.test.js',
  './terms.test.js',
  './privacy.test.js',
];

for (const f of files) {
  require(f);
}
console.log('ALL PAGE TESTS PASSED');
```

- [ ] **Step 2: Run the full suite**

Run: `node tests/run-all.js`
Expected: each individual `PASS: ...` line, then `ALL PAGE TESTS PASSED`.

- [ ] **Step 3: Manual browser verification**

Open each page directly from disk and click through the full nav on every page:

```bash
start index.html
```

Check, for every one of the 8 pages:
- Header logo and nav are present and links work
- Footer shows email, the `[ phone number coming soon ]` placeholder as plain non-clickable text, and Terms/Privacy links
- Fonts render (Fraunces headlines, Inter body, IBM Plex Mono labels/eyebrows)
- Purchase page's "Claim your county" button is visibly greyed out / disabled, not clickable
- Terms and Privacy pages show the red "DRAFT — pending legal review" banner at the top
- Resize the browser window narrow (mobile width) on Home and Pricing and confirm layout doesn't break

- [ ] **Step 4: Commit**

```bash
git add tests/run-all.js
git commit -m "Add full test runner for VDS static site"
```

- [ ] **Step 5: Push to origin**

```bash
git push -u origin main
```

---

## Self-review notes

- **Spec coverage:** all 8 pages from the spec have a task; shared header/nav/footer, brand tokens, phone placeholder rule, disabled purchase button, draft legal banners, `worker/` scaffolding + README, root README with both deploy targets, and CNAME are each covered by a task and a test assertion.
- **Placeholder scan:** no TBD/TODO left in any task; every step has complete, runnable code.
- **Type/naming consistency:** `assertCommonChrome`, `readPage`, `assert`, and `NAV_LINKS` from `tests/helpers.js` (Task 2) are used with identical names and signatures in every later test file (Tasks 3–10). File names (`index.html`, `how-it-works.html`, etc.) match exactly between the nav markup, the CNAME/README references, and the test assertions.
