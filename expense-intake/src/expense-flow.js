// expense-intake/src/expense-flow.js
import { parseExpense, generateSmsCopy } from './providers/index.js';
import { findClientByTwilioNumber, findAuthorizedSender, findHousesForClient, insertExpense, insertPendingReview } from './db.js';
import { getGoogleAccessToken } from './google-auth.js';
import { appendExpenseRow } from './sheets.js';

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

// Static fallback copy, used only if the AI copy-generation call itself fails. Deliberately
// NOT the raw SMS_COPY_ANCHORS strings from providers/shared.js (Step 2) — those contain
// literal bracket placeholders like "[amount]" meant only as few-shot prompt examples, never
// meant to be sent to a client verbatim. These fallbacks substitute the real values instead.
const FALLBACK_SMS_COPY = {
  confirmation: (vars) => `Logged: $${vars.amount}, ${vars.category}, ${vars.house}.`,
  low_confidence: (vars) => `Logged this as ${vars.category} but wasn't fully sure — flagged it for you to double check.`,
  house_selection: () => 'Which house is this for? Address or nickname works.',
};

// A copy-generation failure must never re-trigger writes that already succeeded. By the
// time this is called, `insertExpense`/`appendExpenseRow` or `insertPendingReview` have
// already committed — if generateSmsCopy then throws (rate limit, timeout, network blip,
// all realistic for an external API call) and that exception were allowed to propagate,
// handleSmsWebhook's outer catch would turn it into a 500, Twilio would retry the whole
// webhook, and — since nothing gets cached on a 500 (Task 16) — the retry would reprocess
// from scratch: a second Sheet row, a second expenses/pending_review row, for one physical
// receipt. That's the exact duplicate-write problem Task 16 exists to prevent, reopened by
// an unrelated failure a few lines later. Falling back to static copy instead means the
// pipeline always finishes, gets cached, and Twilio never retries a message whose writes
// already succeeded.
async function safeGenerateSmsCopy(type, vars, env, deps) {
  try {
    return await generateSmsCopy(type, vars, env, deps);
  } catch (err) {
    console.error('generateSmsCopy failed, using fallback copy', { error: err.message, type });
    // Defensive: FALLBACK_SMS_COPY only covers the three types this module currently calls
    // with. If a future call site (e.g. Step 7's monthly_nudge Cron Trigger) invokes this
    // with a type that hasn't been given a fallback entry, FALLBACK_SMS_COPY[type] is
    // undefined — calling it would throw a TypeError from inside this catch block itself,
    // reopening the exact uncaught-exception bug this function exists to close. A generic
    // last-resort string keeps the guarantee unconditional.
    const fallback = FALLBACK_SMS_COPY[type];
    return fallback ? fallback(vars) : 'We logged this — reply if something looks off.';
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

  const houses = await findHousesForClient(env.DB, client.id);
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
    await insertPendingReview(env.DB, {
      clientId: client.id,
      houseId: null,
      amountGuess: parsed ? parsed.amount : null,
      categoryGuess: parsed ? parsed.category : null,
      photoR2Key,
      rawText: parsed ? parsed.raw_text : (fields.body || ''),
      confidence: parsed ? parsed.confidence : 0,
      expiresAt: pendingReviewExpiresAt(),
    });
    const smsBody = await safeGenerateSmsCopy('house_selection', {}, env, deps);
    return { smsBody };
  }

  const house = houses[0];

  if (parsed && parsed.confidence >= CONFIDENCE_THRESHOLD && parsed.amount != null) {
    if (!house.google_sheet_id) {
      // A house with no Sheet set up is an onboarding gap, not a runtime parsing issue —
      // surface it loudly (visible in wrangler tail) rather than silently losing the expense
      // into pending_review, which would mask a real setup bug during manual (pre-step-9) onboarding.
      throw new Error(`House ${house.id} has no google_sheet_id configured`);
    }
    const accessToken = await getGoogleAccessToken({ serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl: deps.fetchImpl });
    const photoUrl = photoR2Key ? receiptPhotoUrl(env.WORKER_BASE_URL, photoR2Key) : '';
    await appendExpenseRow({
      accessToken,
      spreadsheetId: house.google_sheet_id,
      row: [todayIso(), parsed.vendor, parsed.amount, parsed.category, parsed.confidence, photoUrl, parsed.raw_text, fields.from, ''],
      fetchImpl: deps.fetchImpl,
    });
    await insertExpense(env.DB, {
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
    });
    const smsBody = await safeGenerateSmsCopy('confirmation', {
      amount: parsed.amount != null ? parsed.amount.toFixed(2) : '0.00',
      category: parsed.category,
      house: house.nickname || house.address,
    }, env, deps);
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
