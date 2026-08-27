# Expense Intake Worker — Gmail API Transport Swap — Design Spec

Date: 2026-08-26
Branch: `worktree-expense-intake-email-channel` (continues the existing email-intake work; see [`2026-08-25-expense-intake-email-channel-design.md`](2026-08-25-expense-intake-email-channel-design.md) for the pipeline this builds on)

## Background

The email receipt-intake channel (design spec 2026-08-25) was fully implemented against Cloudflare Email Routing (inbound) + Cloudflare Email Sending (outbound `send_email` binding) — sender resolution, D1 schema, MIME parsing (`postal-mime`), photo storage, channel-aware `expense-flow.js`, and a full test suite all exist and work. During live smoke testing, Email Sending turned out to be gated behind the Workers Paid plan, which was never onboarded. This spec replaces *only the transport layer* — how mail gets in and out of the Worker — with the Gmail API, authenticated as `venturesdatasolutions@gmail.com`. Everything upstream of "how do bytes get to/from an inbox" (sender resolution, parsing, expense filing, reply composition) is untouched.

Intake address: subscribers email `venturesdatasolutions@gmail.com` directly (no Cloudflare Email Routing, no `intake.` subdomain, no DNS changes from this Worker's side).

## 1. One-time Google Cloud / OAuth setup (manual, human step)

1. Create (or reuse) a Google Cloud project.
2. Enable the **Gmail API** for that project (APIs & Services → Library).
3. Configure the **OAuth consent screen**: External user type, add `venturesdatasolutions@gmail.com` as a test user. Add scope `https://www.googleapis.com/auth/gmail.modify` (this single scope covers list/get/mark-as-read *and* send — no separate `gmail.send` needed).
4. **Publish the consent screen to "In production."** `gmail.modify` is a Google-classified *Restricted* scope; while the app sits in "Testing" status, Google hard-expires every refresh token after 7 days, which would silently break the poller weekly. Publishing to production (without necessarily completing full Google security verification, which is a heavier process mainly relevant at higher user counts) removes that 7-day cap. You'll see an "unverified app" interstitial once during the consent flow — click through it, since this is your own app authorizing your own account.
5. Create OAuth credentials: **Application type = Desktop app** (not Web) — this allows the one-time authorization to happen via a loopback redirect without standing up a public callback URL.
6. Run the one-time consent flow (I'll provide a small local script) to exchange an authorization code for a refresh token.
7. You provide me the resulting **client ID, client secret, and refresh token** — I do not generate or guess these; they're stored only as Worker secrets, never committed.

## 2. Inbound: Cron poll, not Pub/Sub push

New Cron Trigger, `*/2 * * * *`, added alongside the existing daily-purge/monthly-nudge crons in `wrangler.toml` and dispatched in `src/index.js`'s `scheduled()`.

**Why poll over push:** `users.watch()` push notifications still require a renewal cron every <7 days (watch subscriptions expire) — push doesn't remove the need for a Cron Trigger, it adds a second one. Push also requires provisioning a Cloud Pub/Sub topic, granting `gmail-api-push@system.gserviceaccount.com` publish rights, and a public Worker route that can validate Pub/Sub's push payload — meaningfully more GCP surface for a low-volume personal mailbox. Polling fits the pattern this Worker already uses for scheduled work.

Each poll invocation (`src/gmail-poll.js`, new):
1. Get a valid access token (§4).
2. `GET users.messages.list?q=is:unread&maxResults=25` — bounded batch size to stay well inside Cron Trigger CPU limits.
3. For each message ID, sequentially (not parallel — mirrors the SMS path's one-at-a-time processing and avoids concurrent writes to the same house-selection KV state):
   - Check `getCachedReply(env.CONVERSATION_STATE, gmailMessageId)` (existing `message-dedup.js`, unmodified — it's already keyed generically, not Twilio-specific). If cached, skip reprocessing (goes straight to step e).
   - `GET users.messages.get?id=...&format=raw`, base64url-decode the `raw` field to get the same RFC822 bytes Cloudflare's `message.raw` used to provide.
   - Feed those bytes into the **existing, unmodified** `parseInboundEmail()` from `email-intake.js` (still backed by `postal-mime`) — this is the main reuse win from continuing on this branch instead of starting over.
   - Run the existing `handleEmailWebhook` logic (sender resolution, auto-submitted guard, photo storage, `processResolvedExpenseMessage`), adapted to a Gmail message shape instead of `ForwardableEmailMessage` (see §5).
   - On success: `cacheReply()` the reply text, send the confirmation via Gmail API (§3), then `users.messages.modify` to remove the `UNREAD` label. If the *send* fails, still remove `UNREAD` (the expense is already filed and the reply cached — same "don't fail the whole thing over a send hiccup" reasoning already in the codebase) and log it.
   - On unrecognized sender: send the existing `UNKNOWN_SENDER_REJECT_REASON` text as a normal reply (the closest equivalent to Cloudflare's SMTP-level `setReject`, since a Gmail API poller can't reject a message that's already been delivered to the inbox), then remove `UNREAD` — this is a terminal classification, not worth retrying every 2 minutes.
   - On transient failure (parse error, photo storage error, `processResolvedExpenseMessage` throwing): log and leave the message unread. The next poll retries it automatically — this replaces Cloudflare's implicit "return without rejecting = message dropped" failure mode with a natural retry, which is strictly better.
4. One message's failure doesn't stop the batch — wrap each message's handling in try/catch, continue to the next.

## 3. Outbound: `users.messages.send`

New `buildRawEmail({ to, from, subject, text, html, headers })` helper in `email-intake.js` (or a new `gmail-send.js`) builds an RFC 2822 message and base64url-encodes it, matching what `users.messages.send` expects in its `raw` field. Replaces the `env.EMAIL.send()` call in `handleEmailWebhook` (now the Gmail-poll handler) with a `POST users.messages.send` call carrying that encoded payload, same `In-Reply-To`/`References`/`Auto-Submitted` header logic as today.

## 4. OAuth token exchange + KV caching

New `src/gmail-auth.js`, parallel to (not replacing) the existing `google-auth.js` — Sheets keeps its separate service-account JWT flow as-is; Gmail uses refresh-token exchange since it's a personal (non-Workspace) account, so a service account isn't an option.

`getGmailAccessToken(env)`:
1. Check `env.CONVERSATION_STATE.get('gmail_access_token')` (same KV namespace already used for conversation state — one namespace, multiple key prefixes, matching the existing documented pattern; no new binding needed).
2. If present, return it.
3. Otherwise, `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token` from env secrets. Cache the resulting access token with `expirationTtl` set a little under its actual `expires_in` (Google tokens last ~1 hour; cache for e.g. `expires_in - 120` seconds) so a near-expiry token is never handed out and used a few seconds before it dies.

This satisfies "don't cache in Worker memory across requests, use KV" — the Worker is stateless between invocations regardless of whether it's the cron poll or (indirectly) a future manual trigger.

## 5. Files touched

- **New:** `src/gmail-auth.js` (token exchange + KV caching), `src/gmail-poll.js` (list/get/modify loop, replaces the `email()` handler's role)
- **Changed:** `src/handlers.js` — `handleEmailWebhook` is adapted to take a plain `{ id, raw, headers }`-shaped Gmail message object instead of Cloudflare's `ForwardableEmailMessage`, and its outbound send call swaps to the Gmail helper. Core logic (sender resolution, photo storage, `processResolvedExpenseMessage` call) is unchanged.
- **Changed:** `src/index.js` — remove the `email()` export; add the poll cron to `scheduled()`'s dispatch.
- **Changed:** `wrangler.toml` — remove `[[send_email]]`; add the `*/2 * * * *` cron line; `RECEIPTS_EMAIL_ADDRESS` var updates to `venturesdatasolutions@gmail.com`.
- **Unchanged:** `email-intake.js`'s parsing (`parseInboundEmail`, `stripQuotedReplyText`, `extractReceiptAttachment`), `receipt-storage.js`, `expense-flow.js`, the D1 migration, `db.js`, `onboarding.js`, `message-dedup.js`.

## 6. Secrets

`wrangler secret put GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — provided by you after the one-time consent flow in §1, never committed or placeholder'd in code.

## 7. Testing

- Replace `test/fake-email-message.js` / `test/fake-email-send.js` with a fake Gmail HTTP layer: a `fetchImpl` stub that responds to `users.messages.list`, `users.messages.get`, `users.messages.modify`, and `users.messages.send` URLs with canned JSON — same style as the existing Twilio tests' `fetchImpl` injection (`storeReceiptPhoto` already takes one).
- `test/gmail-poll.test.js` (new): valid receipt email → filed + reply sent + marked read; unrecognized sender → reply sent + marked read, no D1 write; transient failure → left unread, no reply sent; already-cached message ID → skipped without reprocessing, still marked read.
- `test/gmail-auth.test.js` (new): token exchange call shape, KV cache hit skips the network call, cache miss/expiry triggers a fresh exchange.
- Existing `test/email-intake.test.js` (MIME parsing) and `test/email-handlers.test.js` (to the extent it tests sender-resolution/filing logic rather than the Cloudflare-specific plumbing) carry over largely unchanged.

## Out of scope

- Any change to the SMS pipeline.
- DNS records or Cloudflare dashboard configuration (Email Routing/Sending disablement is a dashboard-side action for you to do separately, per your instruction).
- Push-based (Pub/Sub) inbound — reconsider only if 2-minute latency becomes an actual problem in practice.
- Full Google OAuth verification / CASA security assessment for the Restricted scope — noted as a future consideration if usage grows, not required for this personal-use setup.
