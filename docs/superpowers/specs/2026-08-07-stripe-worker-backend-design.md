# VDS Stripe + Cloudflare Worker Backend — Design Spec (Round 2)

Date: 2026-08-07
Scope: The county-exclusivity backend deferred from Round 1 (`docs/superpowers/specs/2026-08-07-static-site-design.md`). Adds a Cloudflare Worker + Workers KV that enforces "one subscriber per county" for real, wires the Purchase page to real Stripe Checkout, and gives subscribers self-serve cancellation via Stripe's Customer Portal.

## Background

Round 1 shipped a fully static 8-page site with a deliberately disabled "Claim your county" button (no backend existed). This round builds that backend and rewires the Purchase page to use it. Business already has a real Stripe account, currently in test/sandbox mode — nothing touches live keys until the business owner manually confirms the test-mode loop works end-to-end and flips Stripe to live mode themselves.

## Architecture

Cloudflare Worker (`worker/`) + one Workers KV namespace, deployed separately from the static site via `wrangler`, at a custom subdomain `api.venturesdatasolutions.com`.

**Routes:**

- `GET /availability/:countyId` — single KV read, returns `{ available: boolean }`. Powers live "already claimed" feedback in the county picker before checkout.
- `POST /checkout` — body `{ countyId }`. Re-checks availability in KV (rejects with a clear "already claimed" error if it just got taken), creates a Stripe Checkout Session in subscription mode, returns `{ url }` for the frontend to redirect to.
- `POST /webhook` — Stripe webhook endpoint. Verifies the Stripe signature using `STRIPE_WEBHOOK_SECRET`. On `checkout.session.completed`: writes the county's KV lock. On `customer.subscription.deleted`: clears the county's KV lock.
- `GET /portal-link?session_id=...` — looks up the given Stripe Checkout Session to find its customer, creates a Stripe Customer Portal session, returns `{ url }`. This is the entire self-cancel mechanism — no login system. It only works from the specific `session_id` Stripe hands back after a successful checkout (used by `purchase-success.html`'s "Manage subscription" link).

CORS on all routes is locked to `https://venturesdatasolutions.com` (and `http://localhost:*` for local dev).

## County master list

A bundled static dataset of all ~3,143 US counties/county-equivalents (name, state, stable ID — e.g. FIPS code). Lives as `assets/counties.json` in the static site (fetched directly by the frontend, not through the Worker) and is also copied into `worker/data/counties.json` so `/checkout` and `/availability` can validate that a submitted `countyId` is real before touching KV. This is an intentional small duplication accepted in place of build tooling to keep both the static site and the Worker deploy-independent with no shared build step.

Every county is claimable from day one — VDS is not pre-vetting which counties it can actually service. To cover that gap: a visible disclaimer near the Claim button and restated in the Stripe Checkout custom text reads roughly *"If we're unable to service your county, you'll be refunded in full within 1–7 business days."* Handling an unserviceable county is a **manual process**: the business owner refunds via the Stripe dashboard and cancels the subscription there, which fires `customer.subscription.deleted` through the existing webhook and unlocks the county automatically — no separate "flag as unserviceable" Worker route.

## Pricing mechanics

Two Stripe Price objects:
- A recurring $150/mo Price — always included as a Checkout line item.
- A one-time $150 Price — included as a second line item only when pricing mode is `"full"`.

Pricing mode is a single KV key (`settings:pricing_mode`, value `"founding"` or `"full"`), defaulting to `"founding"`. The business owner flips it with one `wrangler kv key put` command when VDS is full — no redeploy needed. In `"founding"` mode, checkout charges $150 today and $150/mo after. In `"full"` mode, checkout charges $300 today ($150/mo item + $150 one-time item) and $150/mo after. No subscription-schedule complexity, no second recurring Price.

## Webhook and KV schema

At Checkout Session creation, `countyId` is written into `subscription_data.metadata`, so it lands directly on the resulting Stripe Subscription object. Both webhook events the Worker cares about — `checkout.session.completed` and `customer.subscription.deleted` — can read `countyId` straight off the event payload's subscription metadata, with no extra Stripe API round-trip inside the webhook handler.

KV schema (single namespace, `COUNTY_LOCKS`):
- Key: `countyId`
- Value (JSON): `{ customerId, subscriptionId, claimedAt }`
- Absence of the key means the county is available.

## Race condition handling

Two people could both start checkout for the same county within seconds of each other; only `/checkout`'s pre-creation KV re-check guards against this (returns an "already claimed" error to whoever's request loses the race, before they ever reach Stripe). A window remains between that check and webhook completion where both could theoretically complete payment for the same county. Given the business's scale, this is an accepted limitation, not something worth building distributed locking for (YAGNI) — if it ever happens in practice, it becomes a manual refund case handled the same way as an unserviceable-county refund.

## Frontend changes

`purchase.html` gets real JavaScript (this round explicitly moves off the Round-1 "no JS" static approach, since a working purchase flow requires it):
- Loads `assets/counties.json`, renders a searchable dropdown/combobox.
- On county selection, calls `GET /availability/:countyId` and shows live claimed/available status.
- The "Claim your county" button is enabled only when a valid, available county is selected.
- On click, calls `POST /checkout`, redirects the browser to the returned Stripe Checkout URL.
- Shows the refund disclaimer text near the button.

New page `purchase-success.html`: the Stripe Checkout success redirect target (`?session_id={CHECKOUT_SESSION_ID}`). Shows a confirmation message and a "Manage subscription" link that calls `GET /portal-link?session_id=...` and redirects to the returned Stripe Customer Portal URL.

## Secrets and deployment

- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set as Cloudflare Worker secrets via `wrangler secret put`, test-mode keys first — never hardcoded, never committed, never pasted into any AI chat.
- `wrangler.toml` defines the KV namespace binding and the `api.venturesdatasolutions.com` custom domain route.
- Stripe API calls are raw `fetch()` calls to Stripe's REST API — no SDK dependency, no MCP server in the shipped Worker (MCP was considered for development convenience but raw API was chosen throughout for consistency and long-term maintainability).
- The business owner runs `wrangler login`, `wrangler secret put`, and `wrangler deploy` themselves (needs their own Cloudflare/Stripe credentials and browser session) — I provide exact commands but don't execute the actual login/deploy.

## Test-mode-first sequencing

Full checkout → payment → webhook → KV-lock → cancel → webhook → KV-unlock loop is built and verified end-to-end using Stripe test-mode keys and Stripe's test card numbers before live keys are ever discussed. Switching to live keys is a separate, deliberate, manually-triggered step after the business owner confirms the test-mode checklist passes and has switched their Stripe account to live mode themselves.

**Test-mode checklist** (walked through together before going live):
- [ ] `/availability/:countyId` correctly reports a fresh county as available
- [ ] Checkout Session created successfully for a test county
- [ ] Test payment completes with a Stripe test card
- [ ] Webhook fires and Worker receives `checkout.session.completed`
- [ ] KV correctly marks that county as taken
- [ ] `/availability/:countyId` now reports that county as unavailable
- [ ] `/checkout` rejects a second attempt on the same county with a clear error
- [ ] Canceling the test subscription in Stripe fires `customer.subscription.deleted`
- [ ] KV correctly clears that county back to available
- [ ] `/portal-link` + Stripe Customer Portal works for a test subscriber to self-cancel
- [ ] "Full" pricing mode correctly charges $300 today / $150/mo after when flipped on

## Out of scope (this round)

- User accounts/login — Customer Portal via `session_id` is the entire self-serve mechanism.
- Automated "flag county unserviceable + auto-refund" tooling — manual Stripe dashboard process instead.
- Distributed locking for the checkout race window — accepted limitation at this scale.
- Internal data-pulling/parsing pipeline — separate operational system, unaffected by this round.
