// expense-intake/src/expense-flow.js
import { parseExpense, generateSmsCopy, matchHouseFromReply } from './providers/index.js';
import {
  findClientByTwilioNumber, findAuthorizedSender, findHousesForClient,
  insertExpense, insertPendingReview, findPendingReviewById, deletePendingReview,
  findExpenseById, updateExpenseHouse,
} from './db.js';
import { getGoogleAccessToken } from './google-auth.js';
import { appendExpenseRow, extractAppendedRowNumber, deleteSheetRow } from './sheets.js';
import {
  getAwaitingHouse, setAwaitingHouse, clearAwaitingHouse,
  getCorrectionState, setCorrectionState, clearCorrectionState,
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
};

// A copy-generation failure must never re-trigger writes that already succeeded. By the
// time this is called, the relevant write has already committed — if generateSmsCopy then
// throws (rate limit, timeout, network blip, all realistic for an external API call) and
// that exception were allowed to propagate, handleSmsWebhook's outer catch would turn it
// into a 500, Twilio would retry the whole webhook, and — since nothing gets cached on a 500
// (Task 16) — the retry would reprocess from scratch. Falling back to static copy instead
// means the pipeline always finishes, gets cached, and Twilio never retries a message whose
// writes already succeeded.
async function safeGenerateSmsCopy(type, vars, env, deps) {
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
// high-confidence auto-file path and by a house-selection reply that resolves a pending
// item (Step 5) — both need the exact same write sequence.
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
  const expenseId = await insertExpense(env.DB, {
    houseId: house.id,
    date: todayIso(),
    vendor: parsed.vendor,
    amount: parsed.amount,
    category: parsed.category,
    confidence: parsed.confidence,
    photoR2Key,
    rawText: parsed.raw_text,
    loggedByPhone: fields.from,
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

  const houses = await findHousesForClient(env.DB, client.id);

  // A reply's text is checked against any in-flight house-selection prompt or open
  // correction window before it's treated as a brand-new expense message. A photo-only
  // message (no body text) has nothing to match against a house name, so it always skips
  // straight to normal processing — same as Step 4's existing empty-body-for-text handling.
  if (fields.body) {
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
