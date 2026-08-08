# Venture$ Data Solutions — Website

Static marketing + purchase site for Venture$ Data Solutions (VDS), backed by a Cloudflare Worker for Stripe checkout and county-exclusivity enforcement.

## What's here

- Root-level `.html` files — the static site (Home, How It Works, Pricing, Purchase, Purchase Success, FAQ, Contact, Terms, Privacy).
- `assets/` — brand assets (logo, icon, `styles.css`, `counties.json`), plus `purchase.js` / `purchase-success.js` (the only JS on the site).
- `scripts/build-counties.js` — one-time generator for `assets/counties.json` / `worker/data/counties.json` from the U.S. Census Bureau's county FIPS reference file. Re-run only if the county list ever needs regenerating.
- `worker/` — the Cloudflare Worker source for the Stripe + county-lock backend. Deploys separately from the static site, via `wrangler`, not GitHub Pages. See `worker/README.md` for setup and deploy instructions.
- `tests/` — plain Node scripts (no dependencies) that check every page's structure and the county dataset. Run with `node tests/run-all.js`. (The Worker has its own equivalent suite: `node worker/test/run-all.js`.)
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and implementation plans for this project.

## Deploying the static site (GitHub Pages)

1. Push to the `main` branch of this repo.
2. In GitHub repo Settings → Pages, set the source to `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. The `CNAME` file in this repo already points GitHub Pages at `venturesdatasolutions.com`. DNS for that domain is managed in Cloudflare — confirm a `CNAME`/`A` record there points at GitHub Pages per GitHub's custom domain docs.
4. No build step — GitHub Pages serves the `.html`/`assets/` files as-is.

## Deploying the Cloudflare Worker (separate, `api.venturesdatasolutions.com`)

The Worker in `worker/` is deployed independently of the static site, using `wrangler` from within the `worker/` folder. Stripe secret keys and webhook signing secrets are set as Worker secrets, never committed to this repo. See `worker/README.md` for full setup and deploy steps, including the test-mode-first sequencing before ever touching live Stripe keys.

## Running the tests locally

```bash
node tests/run-all.js       # static site + county dataset
node worker/test/run-all.js # Worker business logic
```

Both suites are structural/logic checks with zero npm dependencies — they don't replace opening the pages in a browser, or running `wrangler dev` against real Stripe test-mode keys for a true end-to-end check (see the test-mode checklist in `docs/superpowers/specs/2026-08-07-stripe-worker-backend-design.md`).
