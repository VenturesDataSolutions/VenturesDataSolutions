# Expense Intake Worker — Pending Review Queue + Pending Retrieval — Design Spec

Date: 2026-08-18
Scope: Build Order step 6 of `docs/superpowers/plans/2026-08-17-expense-intake-worker.md` — a client-initiated `"pending"` command that lets a client work through their stuck `pending_review` items over SMS: items left there by a low-confidence parse, or by Step 5's house-selection flow giving up after a second non-matching reply.

## Background

By the end of Step 5, items can pile up in `pending_review` with no way to resolve them except manual SQL: a low-confidence parse with a known house, or an ambiguous-house item that exhausted its two house-selection attempts. The spec's `monthly_nudge` SMS copy (already built in Step 2) tells the client to "Text 'pending' to review" — this step builds the command that copy refers to.

## Trigger and priority

An inbound message whose body, trimmed and lowercased, is exactly `"pending"` is checked **first** in `processExpenseMessage` — before the Step 5 `awaiting_house`/`correction` checks, and before normal parsing. This is a deliberate override: texting `"pending"` always starts a fresh queue walkthrough, even if the client happens to have an open house-selection prompt or correction window from Step 5 at that moment. Neither of those states is explicitly cleared by starting a pending walkthrough — they simply expire on their own 10-minute TTLs if left unanswered, exactly as they would if the client had gone silent instead of texting `"pending"`.

## Queue state

A new KV key, `pending_queue:<phone>` (same `CONVERSATION_STATE` namespace, 24-hour TTL — this is an on-demand session, not a time-critical window, so a longer TTL than Step 5's 10-minute windows is appropriate), stores `{ pendingReviewId }`: a cursor pointing at whichever item was most recently shown to this phone.

- Texting `"pending"` always fetches the **oldest** `pending_review` row for the client (`ORDER BY id ASC LIMIT 1`), regardless of any existing cursor — a fresh command restarts from the beginning, so previously-skipped items resurface on a later pass.
- While `pending_queue:<phone>` state exists, the client's next reply is interpreted in this order:
  1. `"skip"` (trimmed, case-insensitive) — advance to the next item after the cursor (`WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1`), leaving the current item untouched in `pending_review`.
  2. `"delete"` (trimmed, case-insensitive) — delete the current item, then advance the same way as `"skip"`.
  3. A house-name match via the same `matchHouseFromReply` primitive Step 5 built — files the item (see "Filing a queued item" below), deletes it, then advances the same way as `"skip"`.
  4. None of the above — the state is left untouched (the cursor still points at the same item) and the message falls straight through to normal new-expense processing. Unlike Step 5's house-selection flow, there's no retry-then-give-up loop here: this is a client-initiated, on-demand session, not a system-initiated prompt with a small number of interaction attempts to protect, so an unrecognized reply just gets treated as whatever it looks like on its own.
- Whenever advancing (after skip, delete, or a resolution) finds no next item, the queue state is cleared and the reply is the "all caught up" message instead of another item prompt.

## Filing a queued item

Reuses Step 4/5's `fileExpense` helper exactly as-is: the item's `amount_guess`/`category_guess` (`category_guess || 'Other'`, matching Step 5's house-selection resolution)/`confidence`/`raw_text`/`photo_r2_key` become the `parsed` input, and the matched house is whichever house `matchHouseFromReply` returned — regardless of whether the item already had a `house_id` set. This applies uniformly to both origins of a pending item (low-confidence-with-known-house, and gave-up-house-selection) rather than special-casing one of them, since `fileExpense` doesn't care where its inputs came from.

## Chaining behavior

`"skip"` and `"delete"` reply with the next item's prompt (or the "all caught up" message) in the same SMS — the client doesn't need to re-text `"pending"` to keep moving through the queue. A successful house-match resolution replies with just `fileExpense`'s own confirmation copy (kept short and unambiguous — "logged" is the message, not "logged, and here's your next pending item too"); the client re-texts `"pending"` to continue if they want the next one.

## New SMS copy types

Two additions to `SMS_COPY_ANCHORS`:
- `pending_item_prompt` — vars `{ amount, category, date }`. Shows the guessed amount/category/date and the three available replies (house name / skip / delete).
- `pending_empty` — no vars. "You're all caught up" acknowledgment, used both when `"pending"` finds nothing and when advancing past the last item.

Both need `safeGenerateSmsCopy`-compatible static fallbacks in `expense-flow.js`'s `FALLBACK_SMS_COPY`, following the established pattern.

## New query helpers

Two additions to `db.js`:
- `findOldestPendingReviewForClient(db, clientId)` — `SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1`.
- `findNextPendingReviewForClient(db, clientId, afterId)` — `SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1`.

## Where the logic lives

The queue-handling logic (trigger detection, cursor advancement, filing) is added directly into `expense-flow.js` alongside Step 5's `handleAwaitingHouseReply`/`tryApplyCorrection`, rather than a new module — it needs the same private helpers (`fileExpense`, `safeGenerateSmsCopy`, `houseLabel`) that are intentionally not exported from that file, and splitting it out would mean either exporting internals that have no other consumer or duplicating them. The three new `conversation-state.js` KV helpers (`getPendingQueueState`/`setPendingQueueState`/`clearPendingQueueState`) do belong in that existing shared module, matching Step 5's `awaiting_house`/`correction` helpers.

## Out of scope for this step

- Amount/category correction from within the queue (matches Step 5's "house only" correction scope — a queued item's amount/category are whatever was originally guessed).
- The monthly nudge Cron Trigger that tells a client how many items are waiting (Build Order step 7) — this step only builds the `"pending"` command itself, which already works standalone regardless of whether anything ever prompts the client to use it.
- Any interaction between an active `pending_queue` session and Step 5's `awaiting_house`/`correction` states beyond "pending always overrides" — no explicit cross-clearing, no combined/merged flows.
