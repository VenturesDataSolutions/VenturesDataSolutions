# Expense Intake Worker

Cloudflare Worker that powers the multi-tenant SMS expense tracker for real
estate investors: client texts a receipt to a dedicated Twilio number, the
Worker parses/categorizes it, writes it to the property's Google Sheet, and
texts back a confirmation. Deploys independently of `worker/` (Stripe/county
availability) and of the static site.

See `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` for the
implementation plan and Build Order.

## Status

Build Order steps 1-2: repo scaffolding, `wrangler.toml`, the D1 schema
migration, and the provider abstraction (`src/providers/`) with both the
OpenRouter and Anthropic adapters, unit-tested standalone. No routes are
wired up yet — every HTTP request still 404s; nothing calls the provider
abstraction for real yet (that starts at Build Order step 4).

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
