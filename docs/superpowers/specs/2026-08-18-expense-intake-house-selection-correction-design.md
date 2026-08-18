# Expense Intake Worker — House-Selection Flow + 10-Minute Correction Window — Design Spec

Date: 2026-08-18
Scope: Build Order step 5 of `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` — the two features deferred out of Step 4: the interactive house-selection reply flow, and the 10-minute post-confirmation correction window. Both reuse the `CONVERSATION_STATE` KV namespace already provisioned in Step 4.

## Background

Step 4 shipped the happy-path pipeline: parse → categorize → file to Sheets/D1, or hold in `pending_review` when confidence is low or the client has zero/multiple houses ("house ambiguous"). In the house-ambiguous case, the client is asked "Which house is this for?" but the reply is never actually matched back to the pending item — it's processed as an independent new message. There is also no way for a client to correct a mistaken house assignment after an expense has already been auto-filed. This step closes both gaps.

## Shared primitive: AI-assisted house matching

A single new provider function, `matchHouseFromReply({ text, houses }, env, deps)`, is added to the provider abstraction (alongside `parseExpense`/`generateSmsCopy` in `src/providers/shared.js` + `openrouter.js` + `anthropic.js` + `index.js`, following the exact pattern already established in Step 2). Given the reply text and the client's houses (`{ id, address, nickname }[]`), it asks the model which house (if any) the reply refers to and returns `{ houseId }` (`houseId` is `null` on no confident match). Both features below are built on top of this one primitive — house-selection resolution and correction-window intent detection are the same underlying question ("does this reply name one of the client's houses?") asked at two different points in the flow.

## Feature 1: House-selection resolution

**State:** When `processExpenseMessage` files an expense to `pending_review` because the client's house list isn't exactly length 1, it also writes `awaiting_house:<senderPhone>` to `CONVERSATION_STATE` — `{ pendingReviewId, clientId, attempt: 0 }`, 10-minute TTL.

**On the next inbound message from that phone number**, before any other processing: if `awaiting_house:<phone>` exists, call `matchHouseFromReply` with the reply text and the client's current house list.
- **Match found:** file the pending item for real — write the Sheet row + `expenses` row (via the shared `fileExpense` helper, see below), delete/resolve the `pending_review` row, clear the `awaiting_house` state, start the correction-window state (Feature 2), and reply with confirmation copy.
- **No match, first attempt (`attempt === 0`):** reply with a new `house_selection_retry` SMS copy type that explicitly lists the client's house nicknames/addresses (rather than the generic open-ended prompt), and rewrite `awaiting_house` with `attempt: 1` (same original 10-minute deadline — not extended).
- **No match, second attempt (`attempt === 1`):** clear `awaiting_house` entirely, reply with a new `house_selection_giveup` SMS copy type (a short "this one's saved for manual review" acknowledgment), and leave the item sitting in `pending_review` permanently — Build Order step 6's retrieval command is the only way to resolve it from here.

If the 10-minute TTL simply expires with no reply at all, `awaiting_house` disappears from KV on its own and the client's next message is processed as a normal new expense, per Step 4's existing (already-shipped) fallback behavior.

## Feature 2: 10-minute correction window

**State:** Every time `fileExpense` successfully writes an expense (whether from the normal Step 4 auto-file path, or from Feature 1's house-selection resolution), it writes `correction:<senderPhone>` to `CONVERSATION_STATE` — `{ expenseId, houseId, spreadsheetId, sheetRow, clientId }`, 10-minute TTL. Writing this key always **overwrites** any prior value for that phone number, so a correction reply is always understood to target the most recently filed expense.

**On the next inbound message from that phone number** (checked after the `awaiting_house` check, so an in-flight house-selection always takes priority): if `correction:<phone>` exists, call `matchHouseFromReply` with the reply text and the client's houses.
- **Match found:** this is a correction. Delete the old Sheet row (`deleteSheetRow`, using the stored `spreadsheetId`/`sheetRow`), append a new row to the matched house's Sheet, update `expenses.house_id` and `expenses.sheet_row` in D1, clear the `correction` state (one correction per filed expense — a second reply within the same window is no longer treated as a correction), and reply with a new `correction_confirmed` SMS copy type.
- **No match:** this reply is not a correction at all. Leave `correction` state untouched (still valid for its remaining TTL) and fall through to processing the message as a normal new inbound expense (Step 4's existing flow).

Corrections only ever change the house assignment — amount/category/vendor corrections are out of scope for this step (per the "wrong house" framing already present in Step 2's `confirmation` SMS copy anchors: *"10-minute window if this needs a fix"* immediately follows the house-selection context in the spec's tone examples).

## Data model change

New column: `expenses.sheet_row INTEGER` — the 1-indexed row number the expense landed on in its house's Sheet, needed to target it for deletion on a correction. Captured by parsing the row number out of the Sheets API append response's `updates.updatedRange` (e.g. `"Sheet1!A5:I5"` → `5`). Added via `expense-intake/migrations/0002_add_sheet_row.sql`.

## Sheets module changes

- `appendExpenseRow` is changed to return `{ sheetRow }` (parsed from `updatedRange`), instead of returning nothing.
- A new `deleteSheetRow({ accessToken, spreadsheetId, sheetRow, fetchImpl })` uses `POST .../batchUpdate` with a `deleteDimension` request (`ROWS`, `startIndex: sheetRow - 1`, `endIndex: sheetRow`). This targets the default `"Sheet1"` tab, which is always `sheetId` (gid) `0` for a freshly created spreadsheet — the same tab `appendExpenseRow`'s hardcoded `Sheet1!A:I` range already targets. No spreadsheet-metadata lookup is performed; this is a documented assumption, not a runtime-resolved value.

## `fileExpense` helper extraction

The Sheet-append + `insertExpense` + correction-window-state-set sequence currently inlined in Step 4's high-confidence branch of `expense-flow.js` is extracted into a shared `fileExpense({ house, parsed, fields, photoR2Key, env, deps })` helper, since Feature 1's house-selection resolution needs to perform the exact same sequence. This is a refactor of already-shipped, tested code — the existing Step 4 tests for the auto-file path must continue passing unchanged after the extraction.

## New SMS copy types

Three additions to `SMS_COPY_ANCHORS` in `src/providers/shared.js`:
- `house_selection_retry` — re-asks with the actual house list spelled out.
- `house_selection_giveup` — brief acknowledgment that the item is saved for manual review.
- `correction_confirmed` — acknowledges the house was corrected, mirroring `confirmation`'s tone.

Each needs `safeGenerateSmsCopy`-compatible static fallback text (extending `FALLBACK_SMS_COPY` in `expense-flow.js`), following the exact pattern already established for `confirmation`/`low_confidence`/`house_selection` in Step 4.

## Message routing order (final)

Inside `processExpenseMessage`, after the existing empty-message short-circuit and client/sender lookups, the check order is:
1. `awaiting_house:<phone>` state exists → Feature 1 resolution logic.
2. `correction:<phone>` state exists → Feature 2 intent check (falls through to step 3 on no match).
3. Existing Step 4 flow (parse, house-ambiguous → `pending_review` + set `awaiting_house`, confidence branch → `fileExpense` which sets `correction` state, or low-confidence → `pending_review`).

## Out of scope for this step

- Amount/category corrections (house-only, per the design decision above).
- The `pending` retrieval command for items that exhaust house-selection retries (Build Order step 6).
- Any change to the Cron-based purge/nudge jobs (Build Order step 7).
- Concurrent-message races on the same KV keys (e.g. two rapid-fire replies from the same phone) — same accepted best-effort residual gap already documented for Step 4's dedup guard, not a new one introduced here.
