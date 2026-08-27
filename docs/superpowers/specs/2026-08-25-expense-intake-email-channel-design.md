# Expense Intake Worker — Email Receipt Intake Channel — Design Spec

Date: 2026-08-25
Scope: A2P 10DLC carrier compliance fix. The rejected SMS campaign flagged that "consent cannot be a required condition for service or transaction completion" — today, texting a receipt to a client's dedicated Twilio number is the *only* way to log an expense, so an `authorized_senders` row (and therefore SMS consent) is effectively mandatory just to use a feature the client is already paying for. This adds a second, fully independent intake channel (email) so a subscriber can use the product without ever touching SMS.

## Background

`expense-intake` is a multi-tenant Worker: each paying business (`clients`, one dedicated Twilio number each) has one or more `authorized_senders` (individual people allowed to text expenses in) and one or more `houses` (properties, each with its own Google Sheet). `src/expense-flow.js`'s `processExpenseMessage` resolves `client` via the Twilio "To" number, then `sender` via the "From" number, then runs the shared pipeline: parse/categorize (`src/providers/*`), match to a house (asking for clarification if ambiguous, via `src/conversation-state.js` KV state keyed by phone number), file to the house's Sheet + `expenses` table, and reply with SMS copy.

The root cause of the compliance bug is structural, not just missing docs: `authorized_senders.phone_number` is `NOT NULL` (`migrations/0001_init.sql`), so no one can exist in the system at all without a phone number, and SMS consent (`migrations/0003_add_sms_consents.sql`, the `/consent` form) is a prerequisite staff check before `scripts/onboard-client.js` will add that phone number as an authorized sender (`onboarding.js`'s `assertConsentForAuthorizedSenders`). There is no existing self-service enrollment for phone numbers either — onboarding (houses, Twilio numbers, senders) is entirely staff-run via `onboard-client.js`. This design adds email as a fully parallel, independently-sufficient identity an authorized sender can have instead of (or in addition to) a phone number.

## 1. Infra: Cloudflare Email Routing + Email Worker, dedicated subdomain

Intake address: `receipts@intake.venturesdatasolutions.com`. A new subdomain, not the apex — `hello@`/`sales@venturesdatasolutions.com` are live mailboxes today on a provider we didn't confirm, and pointing the apex domain's MX at Cloudflare would require replicating that setup as routing rules with no room for error. A subdomain has its own independent MX, so this is fully additive with zero risk to existing mail.

One-time setup (documented in `expense-intake/README.md`, alongside the existing Twilio/Sheets/R2 manual steps):
```bash
npx wrangler email routing enable intake.venturesdatasolutions.com
npx wrangler email sending enable intake.venturesdatasolutions.com   # needed to send replies
```
Plus a routing rule (Dashboard or `wrangler email routing rules create`) sending `receipts@intake.venturesdatasolutions.com` to this Worker.

`wrangler.toml` changes:
```toml
[[send_email]]
name = "EMAIL"
```
No binding is needed to *receive* mail — the `email()` handler export is wired up by the routing rule, not a wrangler binding.

`postal-mime` becomes this Worker's first real runtime npm dependency (currently zero, per the README). Hand-rolling MIME/multipart/attachment parsing isn't worth the risk here; it's exactly what Cloudflare's own docs recommend for this.

## 2. Data model (new migration `0004_add_email_identity.sql`)

SQLite/D1 can't `ALTER COLUMN ... DROP NOT NULL` directly, so this recreates the two affected tables (standard SQLite 12-step pattern: create new table, copy rows, drop old, rename):

- `authorized_senders`: `phone_number` becomes nullable; new nullable `email TEXT` column; `CHECK (phone_number IS NOT NULL OR email IS NOT NULL)`. New `CREATE UNIQUE INDEX idx_authorized_senders_email ON authorized_senders(email) WHERE email IS NOT NULL`.
  - **Uniqueness is global, not per-client** (unlike `phone_number`, which is unique per `(client_id, phone_number)`). SMS disambiguates the client via which dedicated Twilio number was texted; a single shared inbox has no equivalent "To"-address signal, so the sender's email address alone must resolve to exactly one client. Assumption: the same person doesn't submit receipts by email on behalf of two different client businesses. Flagging this — if that assumption is wrong, we'd need per-client email aliases instead (e.g. plus-addressing), which is a bigger change.
- `expenses`: `logged_by_phone` becomes nullable; new nullable `logged_by_email TEXT`; same "at least one" CHECK. Whichever channel logged the expense populates its own column; the other stays `NULL`.

`scripts/onboard-client.js` / `src/onboarding.js`: `authorizedSenders` config entries gain an optional `email` field; `phoneNumber` becomes optional (entries need at least one). `validateConfig` and `buildOnboardingSql` updated accordingly. `assertConsentForAuthorizedSenders` only checks consent for senders that *have* a phone number — an email-only sender never touches the SMS consent gate at all, which is the actual compliance fix.

## 3. Pipeline reuse

`processExpenseMessage` in `src/expense-flow.js` is split at the identity-resolution boundary. Everything from `findHousesForClient` onward (parse/categorize, ambiguous-house pending-review + `awaiting_house` state, the 10-minute correction window, the `"pending"` queue command, `fileExpense`) is extracted into a shared core, e.g. `processResolvedExpenseMessage({ client, sender, fields, photoR2Key, env, deps })`. Two thin entry points call it:
- `processExpenseMessage` (existing, SMS): resolves `client` via `findClientByTwilioNumber(fields.to)`, `sender` via `findAuthorizedSender(client.id, fields.from)`, then calls the core.
- `processEmailExpenseMessage` (new): resolves `sender` directly via a new `findAuthorizedSenderByEmail(db, email)`, then `client` via `findClientById(sender.client_id)`, then calls the core.

`src/conversation-state.js`'s KV functions (`getAwaitingHouse`/`setCorrectionState`/etc.) already key purely on whatever identity string is passed in (`awaiting_house:${phone}`) — they work unmodified with an email address in place of a phone number, no changes needed there.

`fileExpense` (in `expense-flow.js`) currently always sets `logged_by_phone: fields.from` on the `expenses` insert and always includes `fields.from` in the Sheet row's "logged by" column. It's updated to set `logged_by_phone` or `logged_by_email` depending on which identity resolved the sender (Sheet row column is just a display string either way, no change needed there).

`maybeSendContactCard` (the one-time vCard MMS) is SMS-only and out of scope for the email channel — not requested, no email equivalent needed.

## 4. Email-specific handling (new `src/email-intake.js` + `email()` handler in `src/index.js`)

- **Parsing:** buffer `message.raw` once, parse with `PostalMime.parse()`. Reply text = `parsed.text` with quoted history stripped (new `stripQuotedReplyText()` helper: cuts at the first line matching `/^>/` or `/^On .+wrote:$/i`, trims). First attachment with an image content-type = the receipt photo.
- **Photo storage:** `src/receipt-storage.js`'s `storeReceiptPhoto` currently fetches bytes from a Twilio media URL before running them through the `IMAGES` resize/recompress + R2 `put` pipeline. Adds a sibling function that takes attachment bytes directly (no fetch) and reuses the same resize/store logic.
- **Sender resolution / rejection:** unrecognized `message.from` → `message.setReject(reason)` (a real SMTP-level rejection with a clear reason), not a silent drop. There's no signature-verification equivalent to Twilio's `X-Twilio-Signature` for inbound email, so the sender-address lookup against `authorized_senders.email` *is* the trust boundary — same trust model already accepted for SMS (`fields.from` is trusted there too), just no HMAC to check first.
- **Reply delivery:** `env.EMAIL.send()` with `to: message.from`, `from: "receipts@intake.venturesdatasolutions.com"`, `subject: "Re: " + original subject`, and `headers: { "In-Reply-To": originalMessageId, "References": originalMessageId }` when available, so the thread displays correctly in the subscriber's client. Body is plain text reusing `safeGenerateSmsCopy`'s output verbatim (it's already channel-agnostic).
- **Clarification threading:** correlation is by sender email address + existing KV state (`awaiting_house:<email>` etc.) — the same model already used for SMS — not by parsing `In-Reply-To`/`References` on the inbound side. More robust against mail clients that don't preserve threading headers on reply.

## 5. Testing (`expense-intake/test/`, following the existing plain-Node + fakes convention)

- New `test/fake-email-message.js`: wraps a raw MIME string into the `ForwardableEmailMessage` shape used by the `email()` handler (`from`, `to`, `headers`, a `raw` `ReadableStream`, and a spy-able `setReject`).
- New `test/fake-email-send.js` (or extend an existing fake): `env.EMAIL = { send: async (opts) => { calls.push(opts); ... } }`.
- `postal-mime` runs unmodified in plain Node, so tests build real raw MIME (multipart, text part + image attachment) and parse it with the real library — no fake needed for parsing itself.
- Coverage: (a) a valid receipt email with a photo attachment from a recognized sender logs the expense identically to the equivalent SMS case and sends a confirmation reply; (b) an email from an unrecognized address is rejected via `setReject` with no D1 writes attempted; (c) an ambiguous-house client gets a clarification reply, and a follow-up email from the same address (matched by KV state, not headers) resolves it; (d) — the compliance-critical case — an `authorized_senders` row with only `email` set, `phone_number` `NULL`, and **no** `sms_consents` row at all completes the full flow end to end, proving the feature doesn't depend on any SMS-related state.
- Pure-logic unit tests for `stripQuotedReplyText` and the new db functions (`findAuthorizedSenderByEmail`), same style as existing `test/consent.test.js` etc.

## 6. Docs / marketing copy

- `platform.html:42` and `investors.html:33`: "Text or photo a receipt..." → "Text, email, or photo a receipt..." (or equivalent), presented as an equal option, not a footnote.
- `expense-intake/README.md`: new "Email handler" section mirroring the existing "## Routes" section; onboarding config example updated to show an `email`-only authorized sender; new "Email Routing/Sending setup" section alongside the existing Twilio/Sheets/R2/D1/KV one-time setup sections.
- `privacy.html`: a short addition near the existing "8. SMS/Text Messaging" section disclosing that an email address is collected/used for the same expense-logging purpose when a subscriber uses email intake instead of SMS (not itself an A2P requirement, but keeps the privacy disclosure honest and complete).

## Out of scope

- Any self-service subscriber enrollment UI — email identity is added the same staff-run way phone numbers are today (`onboard-client.js`), per the explicit decision this spec is built on.
- The one-time vCard/contact-card intro (SMS/MMS-only, no requested email equivalent).
- Per-client email aliasing (plus-addressing) — only needed if the "one email = one client" assumption in §2 turns out to be wrong in practice.
- Any change to the existing SMS pipeline's behavior, copy, or data for senders who already have only a phone number.
