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
  stores any attached photo (resized/recompressed, only the first attached
  photo is processed if a message has multiple) to R2, parses/categorizes
  the expense, resolves the client and house, and either files it to that
  house's Google Sheet + the `expenses` table (high confidence, exactly one
  house) or holds it in `pending_review` (low confidence, or an ambiguous
  house) — replying with the appropriate confirmation/low-confidence/
  house-selection SMS copy either way. A repeated Twilio delivery of a
  message already fully processed (identified by `MessageSid`) replays the
  cached reply instead of reprocessing.
- `GET /receipts/:key` — serves a stored receipt photo directly from R2, no
  authentication. Used by the "Photo" column link in each house's Sheet.

## Status

Build Order steps 1-4: repo scaffolding, D1 schema, the provider
abstraction, the Twilio inbound webhook with R2 photo storage, and the full
happy-path pipeline — parse, categorize, file to Sheets/D1 or
`pending_review`, and reply with confirmation copy, with dedup protection
against Twilio's own webhook retries (a repeated delivery of a message
already fully processed replays the cached reply instead of reprocessing).
Not yet built: the interactive house-selection reply flow and 10-minute
correction window (step 5 — right now, an ambiguous-house message is held
in `pending_review` with a prompt, but a client's reply to that prompt
isn't yet matched back to it — step 5 will reuse the same `CONVERSATION_STATE`
KV namespace this step introduced), the `pending` retrieval command
(step 6), Cron Triggers for the daily purge and monthly nudge (step 7),
save-contact onboarding (step 8), and the onboarding CLI script (step 9) —
houses currently need a `google_sheet_id` set via manual SQL before this
pipeline can file to their Sheet.

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

## KV namespace setup (one-time, per environment)

```bash
npx wrangler kv namespace create CONVERSATION_STATE
```

Paste the printed `id` into `wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

## Google service account secret (one-time, per environment)

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

Paste the **entire contents** of the service account's downloaded JSON key
file (Google Cloud Console → IAM & Admin → Service Accounts → Keys) as a
single value. That service account also needs to be shared as an Editor on
every house's Google Sheet — Sheets created by hand for manual testing
before Build Order step 9's onboarding script exists must be shared with
the service account's `client_email` individually, the same way you'd
share a Sheet with a person.

The confidence threshold that decides "confirmation" vs. "pending review"
is `CONFIDENCE_THRESHOLD` in `src/expense-flow.js` (currently `0.7`) —
tune it after seeing how real receipts parse.
