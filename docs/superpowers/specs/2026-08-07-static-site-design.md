# VDS Static Site — Design Spec (Round 1: Static Site Only)

Date: 2026-08-07
Scope: Static marketing + purchase-page site for Venture$ Data Solutions (VDS), deployable to GitHub Pages. Excludes the Stripe/Cloudflare Worker backend, which is a separate follow-up round (see "Out of scope" below).

## Background

VDS is a data extraction company (county tax delinquency & probate records) selling a $150/mo subscription with a hard rule of one subscriber per county. Brand identity, copy direction, and full architecture were worked out in a prior conversation and captured in the original project brief (site structure, brand tokens, Stripe/Workers architecture). This spec covers only the static-site portion of that brief; the backend (Stripe Checkout + Cloudflare Worker + KV county-lock) is designed and built in a later round.

Existing reference assets (already in the repo root): `flyer.html`, `fb-ad.html`, `vds-logo.png`, `vds-icon.png`.

## Known gap — do not fill in

Phone number is not yet available. It appears only as plain, non-interactive text — `[ phone number coming soon ]` — never as a `tel:` link or styled button. Do not invent a number.

## Repo structure

```
index.html            Home
how-it-works.html      How It Works
pricing.html           Pricing
purchase.html          Purchase/Claim (adapted from flyer.html)
faq.html                FAQ
contact.html            Contact
terms.html              Terms of Service (draft)
privacy.html            Privacy Policy (draft)
assets/
  vds-logo.png
  vds-icon.png
  styles.css            Shared brand tokens, layout, component CSS
worker/
  README.md             Placeholder: Worker code lands here in the backend round, deploys separately via wrangler
CNAME                   venturesdatasolutions.com
README.md               Deploy notes — GitHub Pages (static site) and worker/ (Cloudflare Worker) as two distinct, separately-deployed targets
```

Flat files at repo root (no subfolder for pages) since GitHub Pages serves directly from root and the project has no build step.

## Shared header/nav/footer

Implemented as literal duplicated HTML in every page — not a runtime include or templating system, per the no-build-step/no-framework constraint. Nav: Home, How It Works, Pricing, FAQ, Contact. Footer: logo, email (`hello@venturesdatasolutions.com`), phone placeholder, Terms/Privacy links, copyright line.

Trade-off accepted: future nav/footer edits require a find-and-replace across all 8 files. Acceptable at this page count.

## Brand system (reuse exactly, no redesign)

- Colors: `--cream #F5F0E1`, `--forest #2E4736`, `--forest-dark #1E2F25`, `--stamp-red #A8382C`, `--gold #B98F3B`, `--ink #1C2620`.
- Fonts (Google Fonts CDN): Fraunces (display, 500–800) for headlines, Inter for body, IBM Plex Mono for labels/prices/eyebrows.
- Logo: `vds-logo.png` (full lockup) and `vds-icon.png` (mark only) used as-is, transparent backgrounds preserved. `vds-icon.png` is also the favicon.
- Motif: "chaos → structure" (scattered fragments/binary digits converging into an aligned grid) — echoed subtly (e.g. Home hero, section dividers), not overused.
- Tone: direct, confident, no corporate fluff. Emphasizes data freshness, one-subscriber-per-county exclusivity, honest cancellation (no fees, no penalty — you just lose the county).

## Page-by-page plan

- **Home** (`index.html`) — hero pitch using the exclusivity + freshness angle, written fresh for homepage context (not a duplicate of the purchase page copy), links into Pricing and How It Works.
- **How It Works** — pull → parse → deliver process; plain-language explanation of what "one subscriber per county" means in practice.
- **Pricing** — $150/mo, founding-rate framing (price rises to $300 for the first month once VDS is "full," existing/founding subscribers stay at $150/mo either way), cancel-anytime/no-fee messaging, CTA into Purchase.
- **Purchase** (`purchase.html`) — flyer.html's visual design rebuilt as a full page with site chrome (nav/footer added). "Claim Your County" button is visibly disabled with a "Coming soon" state — not wired to Stripe until the backend round. No fake/decorative claim of real-time availability.
- **FAQ** — cancellation terms, "can someone else buy my county while I'm subscribed" (no), data freshness definition, what's included in a pull, contract/commitment (none — cancel anytime).
- **Contact** (`contact.html`) — `mailto:hello@venturesdatasolutions.com` link. Phone shown as the plain-text placeholder described above. No form in this round (mailto only, per decision).
- **Terms of Service** / **Privacy Policy** — draft placeholder copy reflecting recurring monthly subscription, cancel-anytime with no fees/penalties, data for subscriber's own use, standard privacy boilerplate (what's collected via the site, no data resale, contact for questions). Each page carries a visible "Draft — pending legal review" banner; not presented as final legal advice.

Copy for all pages is drafted by Claude from the brand voice/points above (per decision — no pre-written copy supplied), to be edited by the business owner afterward.

## Error handling / correctness details

- Phone placeholder is never a `tel:` link or button — plain text only, so it can't look live by accident.
- Purchase page's disabled button has a clear "Coming soon" visual state rather than a dead/broken-looking click target.
- Terms/Privacy draft banners are visually distinct (not just a small footnote) so they can't be mistaken for finalized legal text.

## Verification

Pure static HTML/CSS — verified by serving the site locally and clicking through all 8 pages in a browser: nav/footer consistency across pages, responsive layout at mobile/desktop widths, correct disabled state on the Purchase button, and correct rendering of the phone placeholder and legal draft banners. Done before this round is called complete.

## Out of scope (this round)

- Stripe Checkout integration, Cloudflare Worker, Workers KV county-lock logic, webhook handling — all deferred to a separate backend design round (flagged by the user as the higher-risk piece needing more back-and-forth).
- Contact form backend — mailto only for now.
- User accounts/login, internal data-pulling/parsing pipeline — out of scope entirely per original brief.
