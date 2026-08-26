// expense-intake/src/expense-flow.js
import { parseExpense, generateSmsCopy, matchHouseFromReply } from './providers/index.js';
import { buildContactCardIntroSms } from './providers/shared.js';
import {
  findClientByTwilioNumber, findAuthorizedSender, findHousesForClient,
  insertExpense, insertPendingReview, findPendingReviewById, deletePendingReview,
  findExpenseById, updateExpenseHouse,
  findOldestPendingReviewForClient, findNextPendingReviewForClient,
  markContactCardSent,
} from './db.js';
import { sendSms } from './twilio.js';
import { getGoogleAccessToken } from './google-auth.js';
import { appendExpenseRow, extractAppendedRowNumber, deleteSheetRow } from './sheets.js';
import {
  getAwaitingHouse, setAwaitingHouse, clearAwaitingHouse,
  getCorrectionState, setCorrectionState, clearCorrectionState,
  getPendingQueueState, setPendingQueueState, clearPendingQueueState,
} from './conversation-state.js';

const CONFIDENCE_THRESHOLD = 0.7; // tunable — see Step 4's Design decisions note in the plan
const PENDING_REVIEW_TTL_DAYS = 60; // matches spec's 60-day auto-purge (Cron Trigger is Build Order step 7)

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function pendingReviewExpiresAt() {
  return new Date(Date.now() + PENDING_REVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function receiptPhotoUrl(baseUrl, photoR2Key) {
  return `${baseUrl}/receipts/${encodeURIComponent(photoR2Key)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadStoredPhotoAsImageInput(bucket, photoR2Key) {
  const object = await bucket.get(photoR2Key);
  if (!object) {
    throw new Error(`Stored receipt photo not found in R2: ${photoR2Key}`);
  }
  const bytes = await object.arrayBuffer();
  return { base64: arrayBufferToBase64(bytes), mediaType: 'image/jpeg' };
}

function houseLabel(house) {
  return house.nickname || house.address;
}

function pendingItemVars(item) {
  return {
    amount: item.amount_guess != null ? item.amount_guess.toFixed(2) : '0.00',
    category: item.category_guess || 'Uncategorized',
    date: item.created_at ? item.created_at.slice(0, 10) : '',
  };
}

// Static fallback copy, used only if the AI copy-generation call itself fails. Deliberately
// NOT the raw SMS_COPY_ANCHORS strings from providers/shared.js (Step 2) — those contain
// literal bracket placeholders like "[amount]" meant only as few-shot prompt examples, never
// meant to be sent to a client verbatim. These fallbacks substitute the real values instead.
const FALLBACK_SMS_COPY = {
  confirmation: (vars) => `Logged: $${vars.amount}, ${vars.category}, ${vars.house}.`,
  low_confidence: (vars) => `Logged this as ${vars.category} but wasn't fully sure — flagged it for you to double check.`,
  house_selection: () => 'Which house is this for? Address or nickname works.',
  house_selection_retry: (vars) => `Sorry, could you confirm — is this for ${vars.house_list}?`,
  house_selection_giveup: () => 'No worries — saved this one for you to sort out later.',
  correction_confirmed: (vars) => `Updated — moved to ${vars.house}.`,
  pending_item_prompt: (vars) => `Pending: $${vars.amount}, ${vars.category}, ${vars.date}. Reply with the house name to file it, "skip" for the next one, or "delete" to discard.`,
  pending_empty: () => "You're all caught up — no pending items to review.",
  monthly_nudge: (vars) => `${vars.X} items waiting on your OK. Text 'pending' to review.`,
};

// A copy-generation failure must never re-trigger writes that already succeeded. By the
// time this is called, the relevant write has already committed — if generateSmsCopy then
// throws (rate limit, timeout, network blip, all realistic for an external API call) and
// that exception were allowed to propagate, handleSmsWebhook's outer catch would turn it
// into a 500, Twilio would retry the whole webhook, and — since nothing gets cached on a 500
// (Task 16) — the retry would reprocess from scratch. Falling back to static copy instead
// means the pipeline always finishes, gets cached, and Twilio never retries a message whose
// writes already succeeded.
export async function safeGenerateSmsCopy(type, vars, env, deps) {
  try {
    return await generateSmsCopy(type, vars, env, deps);
  } catch (err) {
    console.error('generateSmsCopy failed, using fallback copy', { error: err.message, type });
    // Defensive: FALLBACK_SMS_COPY only covers the types this module currently calls with.
    // If a future call site invokes this with a type that hasn't been given a fallback
    // entry, FALLBACK_SMS_COPY[type] is undefined — calling it would throw a TypeError from
    // inside this catch block itself. A generic last-resort string keeps the guarantee
    // unconditional.
    const fallback = FALLBACK_SMS_COPY[type];
    return fallback ? fallback(vars) : 'We logged this — reply if something looks off.';
  }
}

// Writes an already-parsed, already-house-resolved expense to the house's Sheet + the
// expenses table, and opens the 10-minute correction window for it. Shared by the normal
// high-confidence auto-file path, by a house-selection reply that resolves a pending item
// (Step 5), and by resolving an item from the pending queue (Step 6) — all three need the
// exact same write sequence.
async function fileExpense({ house, parsed, fields, photoR2Key, env, deps }) {
  if (!house.google_sheet_id) {
    // A house with no Sheet set up is an onboarding gap, not a runtime parsing issue —
    // surface it loudly (visible in wrangler tail) rather than silently losing the expense
    // into pending_review, which would mask a real setup bug during manual (pre-step-9) onboarding.
    throw new Error(`House ${house.id} has no google_sheet_id configured`);
  }
  const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });
  const photoUrl = photoR2Key ? receiptPhotoUrl(env.WORKER_BASE_URL, photoR2Key) : '';
  const appendResponse = await appendExpenseRow({
    accessToken,
    spreadsheetId: house.google_sheet_id,
    row: [todayIso(), parsed.vendor, parsed.amount, parsed.category, parsed.confidence, photoUrl, parsed.raw_text, fields.from, ''],
    fetchImpl: deps.fetchImpl,
  });
  const sheetRow = extractAppendedRowNumber(appendResponse);
  const isEmailChannel = fields.channel === 'email';
  const expenseId = await insertExpense(env.DB, {
    houseId: house.id,
    date: todayIso(),
    vendor: parsed.vendor,
    amount: parsed.amount,
    category: parsed.category,
    confidence: parsed.confidence,
    photoR2Key,
    rawText: parsed.raw_text,
    loggedByPhone: isEmailChannel ? null : fields.from,
    loggedByEmail: isEmailChannel ? fields.from : null,
    notes: '',
    sheetRow,
  });
  await setCorrectionState(env.CONVERSATION_STATE, fields.from, {
    expenseId,
    houseId: house.id,
    spreadsheetId: house.google_sheet_id,
    sheetRow,
  });
  return safeGenerateSmsCopy('confirmation', {
    amount: parsed.amount != null ? parsed.amount.toFixed(2) : '0.00',
    category: parsed.category,
    house: houseLabel(house),
  }, env, deps);
}

// Resolves an in-flight house-selection prompt (Step 5, Feature 1). Always returns a
// non-null SMS body — every branch here (match, retry, give-up) produces a reply.
async function handleAwaitingHouseReply({ state, houses, fields, env, deps }) {
  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);

  if (houseId != null) {
    const house = houses.find((h) => h.id === houseId);
    const pending = await findPendingReviewById(env.DB, state.pendingReviewId);
    const parsed = {
      vendor: null,
      amount: pending.amount_guess,
      category: pending.category_guess || 'Other',
      confidence: pending.confidence,
      raw_text: pending.raw_text,
    };
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key: pending.photo_r2_key, env, deps });
    await deletePendingReview(env.DB, state.pendingReviewId);
    await clearAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    return smsBody;
  }

  if (state.attempt === 0) {
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId: state.pendingReviewId, attempt: 1 });
    const houseList = houses.map(houseLabel).join(' or ');
    return safeGenerateSmsCopy('house_selection_retry', { house_list: houseList }, env, deps);
  }

  await clearAwaitingHouse(env.CONVERSATION_STATE, fields.from);
  return safeGenerateSmsCopy('house_selection_giveup', {}, env, deps);
}

// Checks whether an inbound reply is a house correction for the most recently filed expense
// (Step 5, Feature 2). Returns the SMS body to reply with if it is a correction, or `null` if
// it isn't — a `null` return tells the caller to fall through to normal message processing,
// and leaves the correction window's state untouched so it's still available for a later reply.
async function tryApplyCorrection({ state, houses, fields, env, deps }) {
  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);
  if (houseId == null) {
    return null;
  }

  const newHouse = houses.find((h) => h.id === houseId);
  if (!newHouse.google_sheet_id) {
    throw new Error(`House ${newHouse.id} has no google_sheet_id configured`);
  }
  const expense = await findExpenseById(env.DB, state.expenseId);
  const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });

  await deleteSheetRow({ accessToken, spreadsheetId: state.spreadsheetId, sheetRow: state.sheetRow, fetchImpl: deps.fetchImpl });

  const photoUrl = expense.photo_r2_key ? receiptPhotoUrl(env.WORKER_BASE_URL, expense.photo_r2_key) : '';
  const appendResponse = await appendExpenseRow({
    accessToken,
    spreadsheetId: newHouse.google_sheet_id,
    row: [expense.date, expense.vendor, expense.amount, expense.category, expense.confidence, photoUrl, expense.raw_text, expense.logged_by_phone, expense.notes],
    fetchImpl: deps.fetchImpl,
  });
  const newSheetRow = extractAppendedRowNumber(appendResponse);

  await updateExpenseHouse(env.DB, { expenseId: state.expenseId, houseId: newHouse.id, sheetRow: newSheetRow });
  await clearCorrectionState(env.CONVERSATION_STATE, fields.from);

  return safeGenerateSmsCopy('correction_confirmed', { house: houseLabel(newHouse) }, env, deps);
}

// Shows a pending item's prompt and sets the queue cursor to it, or — if there is no item —
// clears the cursor and replies with the "all caught up" message. Shared by the initial
// "pending" command and by every skip/delete/resolution advance (Step 6).
async function showPendingItemOrEmpty({ item, phone, env, deps }) {
  if (!item) {
    await clearPendingQueueState(env.CONVERSATION_STATE, phone);
    return safeGenerateSmsCopy('pending_empty', {}, env, deps);
  }
  await setPendingQueueState(env.CONVERSATION_STATE, phone, { pendingReviewId: item.id });
  return safeGenerateSmsCopy('pending_item_prompt', pendingItemVars(item), env, deps);
}

async function handlePendingCommand({ client, fields, env, deps }) {
  const item = await findOldestPendingReviewForClient(env.DB, client.id);
  return showPendingItemOrEmpty({ item, phone: fields.from, env, deps });
}

// Interprets a reply while a pending-queue cursor is active: "skip"/"delete" advance the
// cursor (chaining into the next item's prompt, or the empty message), a house-name match
// resolves the current item. Returns `null` if the reply is none of these, telling the
// caller to fall through to normal message processing — the cursor is left untouched in
// that case, still valid for a later reply.
async function handlePendingQueueReply({ state, client, houses, fields, env, deps }) {
  const normalized = fields.body.trim().toLowerCase();

  if (normalized === 'skip') {
    const next = await findNextPendingReviewForClient(env.DB, client.id, state.pendingReviewId);
    return showPendingItemOrEmpty({ item: next, phone: fields.from, env, deps });
  }

  if (normalized === 'delete') {
    await deletePendingReview(env.DB, state.pendingReviewId);
    const next = await findNextPendingReviewForClient(env.DB, client.id, state.pendingReviewId);
    return showPendingItemOrEmpty({ item: next, phone: fields.from, env, deps });
  }

  const { houseId } = await matchHouseFromReply({ text: fields.body, houses }, env, deps);
  if (houseId == null) {
    return null;
  }

  const house = houses.find((h) => h.id === houseId);
  const pending = await findPendingReviewById(env.DB, state.pendingReviewId);
  const parsed = {
    vendor: null,
    amount: pending.amount_guess,
    category: pending.category_guess || 'Other',
    confidence: pending.confidence,
    raw_text: pending.raw_text,
  };
  const smsBody = await fileExpense({ house, parsed, fields, photoR2Key: pending.photo_r2_key, env, deps });
  await deletePendingReview(env.DB, state.pendingReviewId);
  // No chaining after a resolution (per the design spec) — but the cursor still must be
  // cleared, not just left alone, since it now points at a row that no longer exists. Leaving
  // it would make the client's *next* reply (if not "pending") hit this function again with a
  // stale pendingReviewId, and findPendingReviewById would resolve to null.
  await clearPendingQueueState(env.CONVERSATION_STATE, fields.from);
  return smsBody;
}

// Sends a new authorized sender a tappable vCard the first time they text in — see Step 8's
// design spec. This must never fail or block the sender's actual reply: any error here is
// caught and logged, leaving contact_card_sent_at null so it's simply retried on their next
// message, instead of propagating up and turning a successful expense log into a 500.
async function maybeSendContactCard({ client, sender, fields, env, deps }) {
  if (sender.contact_card_sent_at) {
    return;
  }
  try {
    // Deterministic, not AI-generated — see buildContactCardIntroSms's comment in
    // providers/shared.js for why this one message can't go through safeGenerateSmsCopy.
    const body = buildContactCardIntroSms({ business: client.business_name });
    const mediaUrl = `${env.WORKER_BASE_URL}/contact-card/${client.id}`;
    await sendSms({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: client.twilio_number,
      to: fields.from,
      body,
      mediaUrl,
      fetchImpl: deps.fetchImpl,
    });
    await markContactCardSent(env.DB, sender.id, new Date().toISOString());
  } catch (err) {
    console.error('Failed to send contact card', { senderId: sender.id, error: err.message });
  }
}

export async function processExpenseMessage({ fields, photoR2Key, env, deps = {} }) {
  if (!fields.body && !photoR2Key) {
    return { smsBody: '' };
  }

  const client = await findClientByTwilioNumber(env.DB, fields.to);
  if (!client) {
    return { smsBody: '' };
  }

  const sender = await findAuthorizedSender(env.DB, client.id, fields.from);
  if (!sender) {
    return { smsBody: '' };
  }

  await maybeSendContactCard({ client, sender, fields, env, deps });

  return processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps });
}

// Shared by both channels once a client has been resolved: SMS resolves it via the Twilio "To"
// number (above); the email handler (src/handlers.js's handleEmailWebhook) resolves it via the
// sender's email address instead, since a single shared inbox has no per-client "To" signal.
// Everything from here on — house lookup, the pending-queue/house-selection/correction-window
// checks, parsing/categorizing, and filing — is identical for both channels.
export async function processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps = {} }) {
  const houses = await findHousesForClient(env.DB, client.id);

  // A reply's text is checked against the pending-review queue command/cursor, then any
  // in-flight house-selection prompt or open correction window, before it's treated as a
  // brand-new expense message. A photo-only message (no body text) has nothing to match
  // against a house name or command keyword, so it always skips straight to normal
  // processing — same as Step 4's existing empty-body-for-text handling.
  if (fields.body) {
    const normalizedBody = fields.body.trim().toLowerCase();

    if (normalizedBody === 'pending') {
      const smsBody = await handlePendingCommand({ client, fields, env, deps });
      return { smsBody };
    }

    const pendingQueueState = await getPendingQueueState(env.CONVERSATION_STATE, fields.from);
    if (pendingQueueState) {
      const queueSmsBody = await handlePendingQueueReply({ state: pendingQueueState, client, houses, fields, env, deps });
      if (queueSmsBody !== null) {
        return { smsBody: queueSmsBody };
      }
      // Not a recognized queue action — fall through and process it as a new message below.
    }

    const awaitingHouse = await getAwaitingHouse(env.CONVERSATION_STATE, fields.from);
    if (awaitingHouse) {
      const smsBody = await handleAwaitingHouseReply({ state: awaitingHouse, houses, fields, env, deps });
      return { smsBody };
    }

    const correctionState = await getCorrectionState(env.CONVERSATION_STATE, fields.from);
    if (correctionState) {
      const correctionSmsBody = await tryApplyCorrection({ state: correctionState, houses, fields, env, deps });
      if (correctionSmsBody !== null) {
        return { smsBody: correctionSmsBody };
      }
      // Not a correction after all — fall through and process it as a new message below.
    }
  }

  const image = photoR2Key ? await loadStoredPhotoAsImageInput(env.RECEIPTS_BUCKET, photoR2Key) : null;

  let parsed = null;
  try {
    parsed = await parseExpense({ text: fields.body || null, image }, env, deps);
  } catch (err) {
    console.error('parseExpense failed', { error: err.message });
    parsed = null;
  }

  const houseIsAmbiguous = houses.length !== 1;

  if (houseIsAmbiguous) {
    const pendingReviewId = await insertPendingReview(env.DB, {
      clientId: client.id,
      houseId: null,
      amountGuess: parsed ? parsed.amount : null,
      categoryGuess: parsed ? parsed.category : null,
      photoR2Key,
      rawText: parsed ? parsed.raw_text : (fields.body || ''),
      confidence: parsed ? parsed.confidence : 0,
      expiresAt: pendingReviewExpiresAt(),
    });
    await setAwaitingHouse(env.CONVERSATION_STATE, fields.from, { pendingReviewId, attempt: 0 });
    const smsBody = await safeGenerateSmsCopy('house_selection', {}, env, deps);
    return { smsBody };
  }

  const house = houses[0];

  if (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null) {
    const smsBody = await fileExpense({ house, parsed, fields, photoR2Key, env, deps });
    return { smsBody };
  }

  await insertPendingReview(env.DB, {
    clientId: client.id,
    houseId: house.id,
    amountGuess: parsed ? parsed.amount : null,
    categoryGuess: parsed ? parsed.category : null,
    photoR2Key,
    rawText: parsed ? parsed.raw_text : (fields.body || ''),
    confidence: parsed ? parsed.confidence : 0,
    expiresAt: pendingReviewExpiresAt(),
  });
  const smsBody = await safeGenerateSmsCopy('low_confidence', {
    category: parsed ? parsed.category : 'Uncategorized',
  }, env, deps);
  return { smsBody };
}
