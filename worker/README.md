# VDS Cloudflare Worker

Cloudflare Worker that powers county-availability checks, Stripe Checkout session creation, Stripe webhook handling, and Stripe Customer Portal links for self-serve cancellation. Deploys independently of the static site (which is served by GitHub Pages) via `wrangler`, to the custom domain `api.venturesdatasolutions.com`.

## Routes

- `GET /availability/:countyId` — `{ available: boolean }`
- `POST /checkout` — body `{ countyId }`, returns `{ url }` (Stripe Checkout URL) or `{ error }`
- `POST /webhook` — Stripe webhook receiver (`checkout.session.completed`, `customer.subscription.deleted`)
- `GET /portal-link?session_id=...` — returns `{ url }` (Stripe Customer Portal URL) for the given completed Checkout Session

See `docs/superpowers/specs/2026-08-07-stripe-worker-backend-design.md` for the full design.

## One-time setup (test mode)

Run all of this from inside the `worker/` folder, with the [Stripe Dashboard](https://dashboard.stripe.com) in **test mode**.

0. **Install dependencies** (pulls in the `wrangler` version pinned in `package.json`):

   ```bash
   npm install
   ```

1. **Log in to Cloudflare:**

   ```bash
   npx wrangler login
   ```

2. **Create the KV namespace** that stores county locks:

   ```bash
   npx wrangler kv namespace create COUNTY_LOCKS
   ```

   This prints an `id`. Paste it into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

3. **Create two test-mode Stripe Price objects** (Stripe Dashboard → Product catalog, or via the Stripe CLI/API):
   - A recurring price: $150.00/month.
   - A one-time price: $150.00.

   Copy both Price IDs (`price_...`) into `wrangler.toml`, replacing `price_REPLACE_WITH_RECURRING_PRICE_ID` and `price_REPLACE_WITH_ONETIME_PRICE_ID`.

4. **Set the Stripe secret key** as a Worker secret (use your **test-mode** secret key first — starts with `sk_test_`):

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   ```

5. **Register the webhook endpoint** in the Stripe Dashboard (Developers → Webhooks → Add endpoint) pointing at `https://api.venturesdatasolutions.com/webhook`, subscribed to `checkout.session.completed` and `customer.subscription.deleted`. Copy the generated signing secret (`whsec_...`) and set it. It's fine to register this before deploying (step 6) — Stripe doesn't verify the URL is reachable when you add the endpoint, only when it actually fires:

   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

6. **Deploy:**

   ```bash
   npx wrangler deploy
   ```

7. Confirm DNS: `api.venturesdatasolutions.com` needs a Cloudflare-proxied record so the custom domain route in `wrangler.toml` resolves — Cloudflare's dashboard will prompt for this on first deploy if it isn't already set up.

## Local development

```bash
npx wrangler dev
```

Runs the Worker locally (default `http://localhost:8787`), using the same KV namespace and secrets as configured above (`wrangler dev` uses your real bound resources by default unless you pass `--local`). The frontend (`assets/purchase.js`, `assets/purchase-success.js`) automatically points at `http://localhost:8787` when the site itself is opened from `localhost`/`127.0.0.1`.

## Going live

Switching to live Stripe keys is a separate, deliberate step, done only after the full test-mode checklist in the design spec passes:

1. Flip your Stripe account out of test mode.
2. Create live-mode versions of the two Price objects; update `wrangler.toml`'s `PRICE_RECURRING_ID`/`PRICE_ONETIME_ID`.
3. Re-run `wrangler secret put STRIPE_SECRET_KEY` and `wrangler secret put STRIPE_WEBHOOK_SECRET` with the live-mode values (and register a second, live-mode webhook endpoint in the Stripe Dashboard).
4. `wrangler deploy` again.

## Switching pricing mode (founding → full)

Once VDS is full, flip the pricing mode with a single KV write — no redeploy:

```bash
npx wrangler kv key put --binding=COUNTY_LOCKS "settings:pricing_mode" "full"
```

(Any value other than `"full"` — including an unset key — behaves as `"founding"`.)

**Also update `purchase.html` by hand at the same time.** The price card there (`$150/mo`, "Founding rate" badge) is static marketing copy — it does not read the KV pricing mode, so flipping the KV key alone leaves the page advertising the old price while Stripe Checkout actually charges the new one. Stripe's own checkout page always shows the real, correct total before payment, so no one is overcharged — but a customer who expects $150 and sees $300 mid-checkout is a bad experience. Update the price card text (and commit + redeploy the static site) in the same step you flip the KV key.

## Running the Worker's own tests

```bash
cd worker
node test/run-all.js
```

Zero npm dependencies — plain Node scripts exercise every pure logic module (`counties.js`, `kv.js`, `stripe.js`, `webhook.js`, `handlers.js`) with in-memory fakes for KV and Stripe, plus an integration test that drives the real `src/index.js` HTTP handler using Node's built-in `Request`/`Response`/`fetch` globals. None of this requires `wrangler`, Miniflare, or network access — the only thing these tests *can't* cover is the real Cloudflare KV/Stripe integration, which is why the test-mode checklist in the design spec is a manual walkthrough against `wrangler dev`.
