# Expense Intake Worker

Cloudflare Worker that powers the multi-tenant SMS expense tracker for real
estate investors: client texts a receipt to a dedicated Twilio number, the
Worker parses/categorizes it, writes it to the property's Google Sheet, and
texts back a confirmation. Deploys independently of `worker/` (Stripe/county
availability) and of the static site.

See `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` for the
implementation plan and Build Order.

## Routes

- `POST /sms` — Twilio inbound SMS/MMS webhook. Validates `X-Twilio-Signature`,
  stores any attached photo (resized/recompressed) to R2, and responds with
  TwiML (only the first attached photo is processed if a message has
  multiple). Parsing, categorization, and confirmation SMS content are Build
  Order step 4 — this route currently stores photos and acknowledges
  text-only messages without doing anything else with them yet.

## Status

Build Order steps 1-3: repo scaffolding, `wrangler.toml`, the D1 schema
migration, the provider abstraction (`src/providers/`, unit-tested
standalone, not yet wired into any route), and the Twilio inbound webhook
(`POST /sms`) with signature verification and R2 photo storage. No parsing,
categorization, Sheets writes, or confirmation SMS content yet — those are
Build Order step 4.

## Running the Worker's own tests

```bash
cd expense-intake
node test/run-all.js
```

Zero npm dependencies, same pattern as `worker/`: plain Node scripts exercise
pure logic modules with in-memory fakes, no Miniflare/wrangler required.

## D1 setup (one-time, per environment)

```bash
npx wrangler d1 create expense-intake-db
```

Paste the printed `database_id` into `wrangler.toml`, replacing
`REPLACE_WITH_D1_DATABASE_ID`. Then apply the schema:

```bash
npx wrangler d1 execute expense-intake-db --file=migrations/0001_init.sql          # remote
npx wrangler d1 execute expense-intake-db --local --file=migrations/0001_init.sql  # local dev
```

## AI provider secrets (one-time, per environment)

The provider abstraction reads `AI_PROVIDER` (`openrouter` | `anthropic`,
defaults to `openrouter`) from `wrangler.toml`'s `[vars]`, and the matching
API key from a Worker secret:

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

Set both even in development — flipping `AI_PROVIDER` to `anthropic` in
`wrangler.toml` before a production deploy shouldn't also require a secrets
round-trip.

## R2 bucket and Cloudflare Images setup (one-time, per environment)

```bash
npx wrangler r2 bucket create expense-intake-receipts
```

Cloudflare Images must also be enabled on the account (Dashboard → Images →
Enable) before the `[images]` binding in `wrangler.toml` will work. The free
tier covers 5,000 transformations/month, which this project's expected
volume is well under. **There is no local emulation for the Images
binding** — `npx wrangler dev --remote` is required to exercise the real
resize/recompress behavior; the plain-Node test suite only verifies the
wrapper logic around it (see `test/fake-images.js`).

## Twilio secrets (one-time, per environment)

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
```

Once a Twilio phone number is provisioned (Build Order step 9's onboarding
CLI script), point its messaging webhook at
`https://<this Worker's deployed URL>/sms` — the exact URL configured in
the Twilio console must match what's used to compute
`X-Twilio-Signature` in `src/twilio.js`, or every inbound message will
be rejected with 403.

Configure the webhook URL as `https://...` exactly, with no trailing slash
mismatch — a Cloudflare-side redirect (e.g. from an `http://` webhook URL
under "Always Use HTTPS") will break signature verification, since Twilio
signs the URL it originally POSTed to, not any redirected version. This is
a common way signature checks silently fail in production: every inbound
message 403s with no obvious cause from the Worker side alone.
