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
