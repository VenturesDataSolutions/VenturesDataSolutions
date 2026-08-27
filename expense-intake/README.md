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
  photo is processed if a message has multiple) to R2, then either:
  - resolves an in-flight house-selection prompt or an open 10-minute
    correction window for that sender phone (Build Order step 5), or
  - parses/categorizes the expense fresh, resolves the client and house,
    and either files it to that house's Google Sheet + the `expenses`
    table (high confidence, exactly one house) or holds it in
    `pending_review` (low confidence, or an ambiguous house).

  Every successfully filed expense opens a 10-minute correction window
  (a reply naming a different house moves it); an ambiguous-house write
  opens a house-selection prompt window (a reply naming a house files it,
  a non-matching reply gets one re-ask before falling back to permanent
  `pending_review`). A repeated Twilio delivery of a message already fully
  processed (identified by `MessageSid`) replays the cached reply instead
  of reprocessing.

  A client can also text `"pending"` at any time (this check runs before
  the house-selection/correction checks above) to walk through their
  `pending_review` items one at a time: reply with a house name to file
  the current item, `"skip"` to see the next one, or `"delete"` to discard
  it — `"skip"`/`"delete"` immediately show the next item (or an
  "all caught up" message) in the same reply.
- `GET /receipts/:key` — serves a stored receipt photo directly from R2, no
  authentication. Used by the "Photo" column link in each house's Sheet.
- `GET /contact-card/:clientId` — serves a generated vCard for the given
  client, no authentication (not sensitive data — just a business name
  and the client's own already-public Twilio number). Used as the
  `MediaUrl` for the one-time save-contact MMS a new authorized sender
  gets on their first message.
- **Cron Triggers** (not an HTTP route): a daily job purges expired
  `pending_review` rows (silent, no client-facing message), and a monthly
  job texts every authorized sender of every active client with
  outstanding pending items, using the same `TWILIO_ACCOUNT_SID`/
  `TWILIO_AUTH_TOKEN` secrets as the inbound webhook. See
  `docs/superpowers/specs/2026-08-18-expense-intake-cron-triggers-design.md`.

## Email handler

A Cron Trigger (`*/2 * * * *`, `pollGmailInbox` in `src/gmail-poll.js`) polls
`venturesdatasolutions@gmail.com` via the Gmail API — `users.messages.list?q=is:unread`,
then `users.messages.get?format=raw` for each — instead of a push-based inbound
handler (Cloudflare Workers can't run a persistent listener, and Gmail's own push
notifications still need a renewal cron every <7 days regardless, so polling adds
no real overhead versus push here). The raw MIME bytes are parsed with the same
`postal-mime`-based `parseInboundEmail` the old Cloudflare-based handler used, and
the sender is resolved by matching their From address against
`authorized_senders.email` — then it's the exact same parse/categorize/
house-matching/Sheet-filing pipeline SMS uses (`processResolvedExpenseMessage` in
`src/expense-flow.js`).

An unrecognized sender gets a reply carrying a fixed explanation and the message
is marked read — there's no SMTP-level reject available for an already-delivered
Gmail message the way Cloudflare Email Routing had, so a normal reply is the
closest equivalent. A clarification reply (e.g. "which property is this for?") is
matched back to the original message purely by sender address + the same
`CONVERSATION_STATE` KV state SMS already uses (`awaiting_house:<email>` etc.),
not by parsing `In-Reply-To`/`References` — more robust against mail clients that
don't preserve threading headers on reply. Our own replies still set those headers
so the thread displays correctly in the subscriber's inbox.

An inbound message that looks auto-generated (an `Auto-Submitted` header other
than `no` — vacation autoresponders, bounces) is marked read and dropped, not
processed or replied to, to avoid an auto-reply loop; every real reply this
handler sends carries `Auto-Submitted: auto-replied` on its own outbound headers
for the same reason. A transient failure partway through (photo storage, Sheets/AI
calls) is left **unread** rather than replied to — the next poll retries it
automatically, which is the polling model's version of Cloudflare's old
SMTP-reject-with-retry behavior. See `processGmailMessage` in `src/gmail-poll.js`
for the exact error paths, and
`docs/superpowers/specs/2026-08-26-expense-intake-gmail-transport-design.md` for
why polling was chosen over Gmail push notifications.

This channel exists specifically so a subscriber can use the product without ever
opting into SMS — see
`docs/superpowers/specs/2026-08-25-expense-intake-email-channel-design.md`. An
authorized sender can have an `email`, a `phone_number`, or both; only a sender
with a phone number is ever gated behind the `/consent` SMS opt-in flow.

## Status

All 9 Build Order steps are complete: repo scaffolding, D1 schema, the
provider abstraction, the Twilio inbound webhook with R2 photo storage,
the full happy-path pipeline (parse, categorize, file to Sheets/D1 or
`pending_review`), Twilio-retry dedup protection, the interactive
house-selection reply flow, the 10-minute post-confirmation correction
window, the client-initiated `"pending"` review queue, the daily purge /
monthly nudge Cron Triggers, save-contact onboarding (a one-time vCard
MMS to each newly authorized sender), and the onboarding CLI script
(auto-created/shared Google Sheets + D1 row creation for a new client).
See the specs under `docs/superpowers/specs/2026-08-18-*` and
`docs/superpowers/plans/2026-08-17-expense-intake-worker.md` for the
full history and design rationale of each step.

## Onboarding a new client

**For each house, first create its Google Sheet by hand** (in a real
Google account — a personal Gmail account works fine) and share it with
the service account's `client_email` (from your
`GOOGLE_SERVICE_ACCOUNT_JSON`) as **Editor**. This step can't be
automated: a plain (non-Workspace) service account has no Drive storage
quota of its own and cannot create new files — confirmed against the
real API. Grab each new spreadsheet's ID from its URL (the segment
between `/d/` and `/edit`).

Once a Twilio number has also been purchased for the client (still a
manual step — see "Twilio secrets" below) and you have each house's
spreadsheet ID, everything else is one command:

```bash
node scripts/onboard-client.js path/to/client-config.json path/to/service-account.json
```

The config file lists the client's business name, accounting software,
Twilio number, and its houses (each with the spreadsheet ID from the
step above) and authorized senders:

```json
{
  "businessName": "Acme Rentals",
  "accountingSoftware": "quickbooks_online",
  "twilioNumber": "+15559876543",
  "carePlanTier": "standard",
  "houses": [
    { "address": "123 Main St", "nickname": "Main St", "googleSheetId": "1AbC...xyz" }
  ],
  "authorizedSenders": [
    { "phoneNumber": "+15551234567", "label": "Owner" },
    { "email": "owner@acme.com", "label": "Owner (email-only, no SMS)" }
  ]
}
```

`accountingSoftware` must be one of `quickbooks_online`,
`quickbooks_desktop`, `wave`, `xero`, `csv`. The script writes the
correct header row into each house's already-shared Sheet, then writes
the `clients`/`houses`/`authorized_senders` rows to D1 via
`wrangler d1 execute`. Pass `--local` to target the local D1 emulation
for a dry run instead of the real remote database — the Sheets-writing
step still hits the real API either way, since there's no local
emulation for it. See
`docs/superpowers/specs/2026-08-18-expense-intake-onboarding-cli-design.md`
for the full design (note: that spec's original "auto-create and share
the Sheet" approach turned out not to be possible for a non-Workspace
service account — the design decisions above reflect what was actually
built after that was discovered).

Each authorized sender needs a `phoneNumber`, an `email`, or both — an
email-only sender is never subject to the `/consent` SMS opt-in check
(`assertConsentForAuthorizedSenders` in `src/onboarding.js` only validates
consent for senders that actually have a phone number).

After onboarding, point the client's Twilio number's messaging webhook
at this Worker's `/sms` route (see "Twilio secrets" below) — that step
is still manual, since provisioning/configuring a phone number is a
deliberate, billable action this script intentionally doesn't automate.

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

Step 5 added a second migration for the `sheet_row` column (needed to
delete/move a filed expense's Sheet row on a house correction):

```bash
npx wrangler d1 execute expense-intake-db --file=migrations/0002_add_sheet_row.sql          # remote
npx wrangler d1 execute expense-intake-db --local --file=migrations/0002_add_sheet_row.sql  # local dev
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

## Gmail API setup (one-time, per environment)

1. Create (or reuse) a Google Cloud project and enable the **Gmail API**
   (APIs & Services → Library).
2. Configure the **OAuth consent screen**: External user type, add
   `venturesdatasolutions@gmail.com` as a test user, and add the scope
   `https://www.googleapis.com/auth/gmail.modify` (covers list/get/mark-as-read
   *and* send in one scope).
3. **Publish the consent screen to "In production."** `gmail.modify` is a
   Google-classified Restricted scope; while the app sits in "Testing" status,
   Google hard-expires every refresh token after 7 days, which would silently
   break the poll cron weekly. You'll see an "unverified app" warning once during
   the consent flow — click through it, since this is your own app authorizing
   your own account.
4. Create OAuth credentials: Application type = **Desktop app** (not Web) — this
   allows the one-time authorization to happen via a loopback redirect without a
   public callback URL.
5. Run the one-time consent flow to exchange an authorization code for a refresh
   token.
6. Set the three secrets:

```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
```

No DNS or Cloudflare dashboard changes are needed — inbound/outbound mail now
flows entirely through the Gmail API, not Cloudflare Email Routing/Sending.

## Testing Cron Triggers locally

`wrangler dev` exposes a special endpoint for firing a configured Cron
Trigger without waiting for its real schedule:

```bash
curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"   # daily purge
curl "http://localhost:8787/__scheduled?cron=0+9+1+*+*"   # monthly nudge
```

The plain-Node test suite (`test/scheduled.test.js`, `test/index.test.js`)
covers the actual purge/nudge logic and the `event.cron` dispatch without
needing `wrangler dev` at all — this is only useful for an end-to-end
manual check against real Twilio/D1.

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
