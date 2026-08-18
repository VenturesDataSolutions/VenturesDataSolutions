# Expense Intake Worker — Cron Triggers: Daily Purge + Monthly Nudge — Design Spec

Date: 2026-08-18
Scope: Build Order step 7 of `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` — two independent Cloudflare Cron Triggers: a daily purge of stale `pending_review` rows, and a monthly SMS nudge telling clients how many items are waiting on them. Step 4's design notes already called out that this step is what finally requires an outbound-send capability (`src/twilio.js` had none — every reply so far has been a synchronous TwiML response to an inbound webhook).

## Background

`pending_review.expires_at` has been set to 60 days out on every insert since Step 1's schema, and Step 2's `SMS_COPY_ANCHORS.monthly_nudge` ("`[X] items waiting on your OK. Text 'pending' to review.`") has existed since before there was anything to trigger it. This step wires both up: a Cron Trigger that deletes expired rows, and a Cron Trigger that texts clients with outstanding items.

## Outbound SMS capability (new)

Every SMS reply built so far has been a synchronous TwiML `<Message>` in response to an inbound webhook — there has been no need to originate a message. A Cron Trigger has no inbound webhook to piggyback on, so this step adds the first outbound-send function: `sendSms({ accountSid, authToken, from, to, body, fetchImpl })` in `src/twilio.js`, using Twilio's REST API (`POST https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json`, form-encoded `To`/`From`/`Body`, HTTP Basic Auth with the Account SID as username and Auth Token as password — Twilio's standard REST API auth, the same account already used for the inbound webhook's signature verification and (Step 3) fetching MMS media).

## Daily purge

A Cron Trigger runs `DELETE FROM pending_review WHERE expires_at < ?` (bound to the current time) once a day. This is a **silent** cleanup — no client-facing message, matching the "auto-purge" framing already in `expense-flow.js`'s comments. The number of rows deleted is logged server-side (`console.log`, visible in `wrangler tail`) for observability, nothing more.

## Monthly nudge

A Cron Trigger runs once a month and, for every **active** client (`clients.status = 'active'`) with at least one row currently in `pending_review`, sends the `monthly_nudge` SMS to **every** phone number on that client's `authorized_senders` — not just one "primary" contact, since any authorized sender might be the one who actually needs to act on a given pending item, and the schema has no primary-contact flag to single one out. The nudge is sent from the client's own `twilio_number` (the number clients already recognize as "the expense tracker"), to each sender's `phone_number`.

The count injected into the `monthly_nudge` copy (`SMS_COPY_ANCHORS.monthly_nudge`'s literal `[X]` placeholder — an already-shipped, unusual-looking var name inherited as-is from Step 2, not renamed here) is simply **the client's current total pending_review count** at the moment the cron fires — not a delta since the last nudge, and not scoped to "items not already nudged about." A client with unresolved items gets reminded every month until they clear the queue; there's no new schema/state needed to track "already nudged" per item.

Copy generation reuses the same AI-with-static-fallback pattern already established for every other SMS in this project: `safeGenerateSmsCopy` (currently a private helper in `expense-flow.js`) is exported so the new cron module can call it, and `FALLBACK_SMS_COPY` gains a `monthly_nudge` entry.

## New query helpers

Three additions to `db.js`:
- `deleteExpiredPendingReviews(db, nowIso)` — `DELETE FROM pending_review WHERE expires_at < ?`, returns the number of rows deleted (`result.meta.changes`) for logging.
- `findActiveClientsWithPendingCounts(db)` — a single grouped query (`SELECT c.id AS client_id, c.twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id`) — the `JOIN` (not `LEFT JOIN`) means only clients with at least one pending row come back at all, so there's no need to filter out zero-count clients afterward.
- `findAuthorizedSendersForClient(db, clientId)` — `SELECT * FROM authorized_senders WHERE client_id = ?`, mirroring the existing `findHousesForClient` shape exactly.

## Where the logic lives

A new file, `src/scheduled.js`, exports `purgeExpiredPendingReviews(env, deps)` and `sendMonthlyNudges(env, deps)` — the two Cron-triggered jobs, bundled together the same way `db.js` bundles all D1 query helpers, since both are small, closely-related "the whole Worker's `scheduled()` entrypoint dispatches to one of these two functions" jobs rather than deserving separate files. `src/index.js` gets a new exported `scheduled(event, env, ctx)` handler that reads `event.cron` (Cloudflare's Cron Trigger event carries which of the Worker's configured cron expressions fired) and calls the matching function.

## `wrangler.toml`

```toml
[triggers]
crons = ["0 3 * * *", "0 9 1 * *"]
```

- `"0 3 * * *"` — daily purge, 3:00 UTC. An off-peak hour for a US-timezone client base; not a business-critical exact time, called out as tunable.
- `"0 9 1 * *"` — monthly nudge, 9:00 UTC on the 1st of each month. Also tunable; picked to land in US morning hours for most timezones.

Both schedules are named/commented in `wrangler.toml` so `event.cron`'s dispatch in `index.js` is self-documenting rather than requiring the reader to decode cron syntax to know which job is which.

## Out of scope for this step

- Any change to what counts as "pending" for the nudge beyond a raw current count (no delta tracking, no per-item "already nudged" state).
- A purge-notification message (silent by design, per the decision above).
- Save-contact onboarding (Build Order step 8) and the onboarding CLI script (step 9) — unrelated to this step's Cron Triggers.
