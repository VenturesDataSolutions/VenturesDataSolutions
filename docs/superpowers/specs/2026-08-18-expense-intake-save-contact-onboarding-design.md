# Expense Intake Worker — Save-Contact Onboarding — Design Spec

Date: 2026-08-18
Scope: Build Order step 8 of `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` — sending a new authorized sender a tappable vCard the first time they text in, so their phone shows a friendly business name instead of a raw number on future texts. The schema has carried `authorized_senders.contact_card_sent_at` since Step 1 with nothing writing to it yet; this step is what finally does.

## Delivery mechanism

A vCard is delivered as an MMS attachment: a new public route, `GET /contact-card/:clientId`, serves a generated `.vcf` file (`Content-Type: text/vcard`) for a given client, and the outbound send (Step 7's `sendSms`, extended with an optional `mediaUrl` parameter — Twilio's Messages API treats SMS/MMS through the same endpoint, `MediaUrl` is just an optional form field) points at that URL. Twilio fetches the file and delivers a tappable "Add Contact" card alongside a short text body. This mirrors the existing `GET /receipts/:key` route's trust model (a public, unauthenticated route serving generated content) — a vCard is not sensitive, unlike a receipt photo, so there's no unguessable-key requirement; `clientId` in the URL is fine as a plain integer.

**vCard content** (standard vCard 3.0, CRLF line endings per spec):
```
BEGIN:VCARD
VERSION:3.0
FN:{client.business_name} Expense Tracker
TEL;TYPE=CELL:{client.twilio_number}
END:VCARD
```

## Trigger and failure handling

On every inbound message, immediately after the sender is confirmed authorized (`findAuthorizedSender` succeeds) — before any expense parsing or Step 5/6 flow routing — `processExpenseMessage` checks `sender.contact_card_sent_at`. If it's `null`, the vCard MMS send is attempted:
1. Build the MMS body via the same AI-with-static-fallback pattern (`safeGenerateSmsCopy`) every other outbound message in this project uses — a new `contact_card_intro` copy type, vars `{ business: client.business_name }`.
2. Send via `sendSms` with `mediaUrl` set to `${WORKER_BASE_URL}/contact-card/${client.id}`.
3. On success, mark `authorized_senders.contact_card_sent_at` with the current timestamp (a new `markContactCardSent` D1 helper) so it's never re-sent.
4. On failure (bad number, Twilio hiccup, network blip), log it and leave `contact_card_sent_at` `null` — it's retried automatically on the sender's next message, no special retry bookkeeping needed.

This entire sequence is wrapped so it **cannot fail or block the main reply** — a vCard-send exception is caught internally and never propagates into the rest of `processExpenseMessage`. The client's actual expense (or Step 5/6 flow interaction) for that first message is processed and replied to exactly as it would be for any later message, unaffected by whether the vCard send succeeded, failed, or is still pending. This is a deliberate simplification from a "true fire-and-forget background task" (which would need `ctx.waitUntil` threaded from `src/index.js`'s `fetch` handler all the way down through `handlers.js` and into `expense-flow.js` — a larger plumbing change touching every layer for a non-critical, already-failure-isolated onboarding nicety) — the vCard send is still `await`ed inline, just internally failure-proofed, so it adds one extra outbound HTTP round-trip of latency to a brand-new sender's very first reply and none to any later message.

## New query helpers

Two additions to `db.js`:
- `findClientById(db, id)` — `SELECT * FROM clients WHERE id = ?`, used by the new `/contact-card/:clientId` route handler.
- `markContactCardSent(db, senderId, sentAtIso)` — `UPDATE authorized_senders SET contact_card_sent_at = ? WHERE id = ?`.

## New module

`src/vcard.js` exports a single pure function, `buildVCard({ businessName, phoneNumber })`, returning the vCard text — a small, self-contained formatting concern, matching the existing pattern of dedicated small modules (`twiml.js`, `google-auth.js`) rather than folding vCard-string-building into the route handler.

## New SMS copy type

One addition to `SMS_COPY_ANCHORS`: `contact_card_intro` (vars: `{ business }`), two tone anchors, plus a `FALLBACK_SMS_COPY` entry — following the exact pattern already established for every other copy type.

## Where the logic lives

`maybeSendContactCard({ client, sender, env, deps })` is added as a private helper directly in `expense-flow.js`, alongside the other message-flow orchestration helpers (`fileExpense`, `handleAwaitingHouseReply`, etc.) — it needs `safeGenerateSmsCopy` (already local to that file) and calls into `sendSms`/`markContactCardSent`, and putting it anywhere else would either require exporting `safeGenerateSmsCopy`'s caller-facing internals further or create a circular import. The new `GET /contact-card/:clientId` route handler (`handleGetContactCard`) is added to `handlers.js` alongside `handleGetReceipt`, following that route's exact shape.

## Out of scope for this step

- The onboarding CLI script that actually creates `clients`/`houses`/`authorized_senders` rows in the first place (Build Order step 9) — this step only handles what happens the first time an already-provisioned sender texts in.
- Re-sending a contact card if a client's `business_name` changes later, or any "resend contact card" command — `contact_card_sent_at` is a one-way, one-time flag.
