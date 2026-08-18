// expense-intake/test/expense-flow.test.js
import crypto from 'node:crypto';
import { processExpenseMessage } from '../src/expense-flow.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { client_email: 'test-sa@test.iam.gserviceaccount.com', private_key: privateKey };
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function dispatchFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonOk(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

async function withStoredPhoto(bucket, key) {
  await bucket.put(key, new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
}

function baseEnv(db, bucket, overrides = {}) {
  return {
    DB: db,
    RECEIPTS_BUCKET: bucket,
    CONVERSATION_STATE: createFakeKV(),
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    GOOGLE_SERVICE_ACCOUNT_JSON: generateTestServiceAccount(),
    WORKER_BASE_URL: 'https://expense-intake.example.workers.dev',
    ...overrides,
  };
}

function openRouterHandler(parseContent, copyContent) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const isParse = body.messages.some((m) => Array.isArray(m.content));
    const content = isParse ? parseContent : copyContent;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

// Distinguishes OpenRouter calls by the actual system prompt text (all three of
// parseExpense/matchHouseFromReply/generateSmsCopy send a plain-string system prompt, so
// they can be told apart even though matchHouseFromReply and generateSmsCopy calls otherwise
// look identical in shape). Used only by the Step 5 scenarios below, which exercise more
// than two of these call types in a single test.
function openRouterRouter({ parse, match, copy }) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    let content = copy;
    if (typeof system === 'string' && system.includes('expense-parsing assistant')) content = parse;
    else if (typeof system === 'string' && system.includes('matching a text reply')) content = match;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

async function main() {
  const client = { id: 1, twilio_number: '+15559876543' };
  const sender = { id: 5, client_id: 1, phone_number: '+15551234567' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];

  // 1. Happy path: single house, high confidence, photo message
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    await withStoredPhoto(bucket, 'receipts/x/1.jpg');
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        'Logged: $42.50, Materials, Main St.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '', media: [] },
      photoR2Key: 'receipts/x/1.jpg',
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a high-confidence happy path must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a high-confidence match must insert an expenses row');
    assert(expenseInsert.params[4] === 'Materials', 'the inserted expense must carry the parsed category');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(sheetsCall, 'a high-confidence match must append a row to the house Sheet');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(!pendingInsert, 'a high-confidence match must not also write to pending_review');
  }

  // 2. Low confidence: single house, low-confidence parse -> pending_review, not expenses
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'blurry' }),
        'Saved under Other — flagged for review.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'some note', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a low-confidence match must still produce an SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a low-confidence match must write to pending_review');
    assert(pendingInsert.params[1] === 10, 'a low-confidence match with a known house must still record that house_id in pending_review');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a low-confidence match must not write to expenses');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(!sheetsCall, 'a low-confidence match must not touch the Sheet');
  }

  // 2b. High confidence but null amount: single house, high-confidence parse with an unknown
  // amount -> pending_review, not expenses (a confident category/vendor doesn't make an
  // unreadable total safe to auto-file as $0.00)
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Home Depot', amount: null, category: 'Materials', confidence: 0.9, raw_text: 'torn receipt' }),
        'Saved under Materials — flagged for review.'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'torn receipt', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a high-confidence match with a null amount must still produce an SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a high-confidence match with a null amount must fall through to pending_review');
    assert(pendingInsert.params[1] === 10, 'a high-confidence match with a null amount and a known house must still record that house_id in pending_review');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a high-confidence match with a null amount must not write to expenses');
    const sheetsCall = fetchImpl.calls.find((c) => c.url.includes('sheets.googleapis.com'));
    assert(!sheetsCall, 'a high-confidence match with a null amount must not touch the Sheet');
  }

  // 3. Ambiguous house (two houses): pending_review with house_id null, house_selection copy
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        'Which house is this for?'
      )],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an ambiguous house must still produce a prompt SMS body');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'an ambiguous house must write to pending_review even with high confidence');
    assert(pendingInsert.params[1] === null, "an ambiguous house must record a null house_id, since we don't know which one");
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'an ambiguous house must never write directly to expenses, regardless of confidence');
  }

  // 4. Unknown client: silent ack, no writes
  {
    const db = createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null });
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+10000000000', body: 'hi', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'an unrecognized Twilio "To" number must produce a silent (empty) acknowledgment');
    assert(db.calls.length === 1, 'an unknown client must not proceed past the initial client lookup');
  }

  // 5. Unauthorized sender: silent ack
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': null,
    });
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+19998887777', to: '+15559876543', body: 'hi', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'an unauthorized sender must produce a silent (empty) acknowledgment');
  }

  // 6. Empty message (no body, no photo): silent ack, no D1 lookups at all
  {
    const db = createFakeD1();
    const bucket = createFakeR2Bucket();
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: {},
    });
    assert(result.smsBody === '', 'a genuinely empty message must produce a silent acknowledgment');
    assert(db.calls.length === 0, 'a genuinely empty message must short-circuit before any D1 lookups');
  }

  // 7. Parse failure: treated as confidence 0, routed to pending_review
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
        }
        return { ok: true, status: 200, json: async () => chatResponse('Saved under Uncategorized — flagged for review.') };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'something', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a parse failure must still produce a low-confidence-style SMS body, not crash the whole message');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'a parse failure must fall back to pending_review');
    assert(pendingInsert.params[6] === 0, 'a parse failure must record confidence 0, not a fabricated value');
  }

  // 8. Missing google_sheet_id on the resolved house: throws (a config gap, not silently swallowed)
  {
    const houseWithoutSheet = [{ id: 12, client_id: 1, address: '789 Pine Rd', nickname: null, google_sheet_id: null }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': houseWithoutSheet,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'X', amount: 1, category: 'Other', confidence: 0.99, raw_text: 'X $1' }),
        'unused'
      )],
    ]);
    let threw = false;
    try {
      await processExpenseMessage({
        fields: { from: '+15551234567', to: '+15559876543', body: 'X $1', media: [] },
        photoR2Key: null,
        env: baseEnv(db, bucket),
        deps: { fetchImpl },
      });
    } catch (err) {
      threw = true;
      assert(/google_sheet_id/.test(err.message), 'the error must clearly identify the missing google_sheet_id, not fail with a generic message');
    }
    assert(threw, 'a house with no Sheet configured must throw rather than silently losing a would-be-filed expense');
  }

  // 9. generateSmsCopy fails AFTER the write already succeeded (high confidence): the
  // pipeline must still complete with fallback copy, not throw.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' })) };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Logged: $42.50, Materials, Main St.', 'a generateSmsCopy failure after a successful write must fall back to static confirmation copy with the real values substituted, not throw');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'the write must have already succeeded before the copy-generation failure');
  }

  // 10. generateSmsCopy fails on the ambiguous-house (house_selection) path: must still
  // fall back to static copy, and the pending_review write (house_id null) must have
  // already happened.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' })) };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Which house is this for? Address or nickname works.', 'a generateSmsCopy failure on the ambiguous-house path must fall back to static house_selection copy, not throw');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'the pending_review write must have already succeeded before the copy-generation failure');
    assert(pendingInsert.params[1] === null, 'the ambiguous-house pending_review write must still record a null house_id');
  }

  // 11. generateSmsCopy fails on the low-confidence path: must still fall back to static
  // copy with the real category substituted, and the pending_review write must have already
  // happened.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: null, amount: null, category: 'Other', confidence: 0.2, raw_text: 'blurry' })) };
        }
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'some note', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === "Logged this as Other but wasn't fully sure — flagged it for you to double check.", 'a generateSmsCopy failure on the low-confidence path must fall back to static low_confidence copy with the real category substituted, not throw');
    const pendingInsert = db.calls.find((c) => c.sql.includes('INSERT INTO pending_review'));
    assert(pendingInsert, 'the pending_review write must have already succeeded before the copy-generation failure');
  }

  // 12. Ambiguous house also opens an awaiting_house KV window (Step 5, Feature 1 setup)
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterHandler(
        JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        'Which house is this for?'
      )],
    ]);
    await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $10', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    const state = await kv.get('awaiting_house:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 1 && state.attempt === 0, 'an ambiguous house must open an awaiting_house KV window pointing at the new pending_review row, attempt 0');
  }

  // 13. A house-selection reply that matches resolves the pending item: files the expense
  // (Sheet + expenses), deletes the pending_review row, clears awaiting_house, and opens a
  // correction window for the newly-filed expense.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const pendingRow = { id: 77, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.95 };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE id = ?': pendingRow,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 0 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":11}', copy: 'Logged: $10.00, Materials, 456 Oak Ave.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '456 Oak', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a resolved house-selection reply must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the resolved pending item must be filed under the matched house');
    const pendingDelete = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(pendingDelete && pendingDelete.params[0] === 77, 'the resolved pending_review row must be deleted');
    assert((await kv.get('awaiting_house:+15551234567')) === null, 'awaiting_house state must be cleared once resolved');
    const correctionState = await kv.get('correction:+15551234567', { type: 'json' });
    assert(correctionState && correctionState.houseId === 11, 'resolving a house-selection reply must open a correction window for the newly-filed expense');
  }

  // 14. A house-selection reply that doesn't match, on the first attempt, re-asks with the
  // house list spelled out and bumps attempt to 1 — no file, no delete.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 0 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', copy: 'Sorry, is this for Main St or 456 Oak Ave?' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'not sure', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a first no-match must still produce a re-ask SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(!expenseInsert, 'a first no-match must not file anything');
    const state = await kv.get('awaiting_house:+15551234567', { type: 'json' });
    assert(state && state.attempt === 1 && state.pendingReviewId === 77, 'a first no-match must bump attempt to 1 and keep the same pendingReviewId');
  }

  // 15. A house-selection reply that doesn't match a second time gives up: clears
  // awaiting_house, leaves the item in pending_review permanently (no delete call).
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 1 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', copy: 'No worries, saved for review.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'still not sure', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a second no-match must still produce a give-up SMS body');
    const pendingDelete = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(!pendingDelete, 'a second no-match must leave the pending_review row in place for manual resolution');
    assert((await kv.get('awaiting_house:+15551234567')) === null, 'a second no-match must clear awaiting_house so the client is not stuck being re-prompted forever');
  }

  // 16. A correction-window reply that matches a different house moves the expense: deletes
  // the old Sheet row, appends to the new house's Sheet, updates expenses.house_id/sheet_row,
  // and clears the correction window.
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const filedExpense = {
      id: 42, house_id: 10, date: '2026-08-17', vendor: 'Home Depot', amount: 42.5, category: 'Materials',
      confidence: 0.9, photo_r2_key: null, raw_text: 'HD $42.50', logged_by_phone: '+15551234567', notes: '', sheet_row: 5,
    };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM expenses WHERE id = ?': filedExpense,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'correction:+15551234567': JSON.stringify({ expenseId: 42, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', async (url, init) => {
        if (url.includes(':batchUpdate')) return { ok: true, status: 200, json: async () => ({ replies: [{}] }) };
        return { ok: true, status: 200, json: async () => ({ updates: { updatedRange: 'Sheet1!A2:I2' } }) };
      }],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":11}', copy: 'Updated — moved to 456 Oak Ave.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'wrong house, it was 456 Oak', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a matched correction must produce a confirmation SMS body');
    const deleteCall = fetchImpl.calls.find((c) => c.url.includes(':batchUpdate'));
    assert(deleteCall, 'a matched correction must delete the old Sheet row via batchUpdate');
    const appendCall = fetchImpl.calls.find((c) => c.url.includes(':append'));
    assert(appendCall, "a matched correction must append a new row to the new house's Sheet");
    assert(appendCall.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/sheet_def/'), "the new row must be appended to the matched house's spreadsheet, not the original one");
    const houseUpdate = db.calls.find((c) => c.sql.includes('UPDATE expenses SET house_id'));
    assert(houseUpdate && JSON.stringify(houseUpdate.params) === JSON.stringify([11, 2, 42]), 'the expense row must be updated to the new house_id and new sheet_row');
    assert((await kv.get('correction:+15551234567')) === null, 'a successful correction must clear the correction window — one correction per filed expense');
  }

  // 17. A correction-window reply that doesn't match any house is not a correction at all —
  // it falls through and gets processed as a brand-new expense message, and the correction
  // window ends up re-set to point at that new expense (fileExpense always opens a fresh
  // correction window on every successful file, per the Design decisions above).
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'correction:+15551234567': JSON.stringify({ expenseId: 42, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ updates: { updatedRange: 'Sheet1!A3:I3' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', parse: JSON.stringify({ vendor: 'Lowes', amount: 8, category: 'Materials', confidence: 0.9, raw_text: 'Lowes $8' }), copy: 'Logged: $8.00, Materials, Main St.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $8 for screws', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a non-matching correction-window reply must still produce a normal SMS body from the fallthrough processing');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a non-matching correction-window reply must be processed as a new expense (high confidence, single house)');
    const correctionState = await kv.get('correction:+15551234567', { type: 'json' });
    assert(correctionState && correctionState.expenseId === 1, 'the correction window must be overwritten to point at the newly-filed expense, not left stale pointing at the old one');
  }

  // 18. "pending" with no pending items replies with the empty message, no queue state set
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': null,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: "You're all caught up." })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'pending', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"pending" with nothing pending must still produce a reply');
    assert((await kv.get('pending_queue:+15551234567')) === null, 'no queue state should be set when there is nothing pending');
  }

  // 19. "pending" (case/whitespace-insensitive) with an item shows its prompt and sets the cursor
  {
    const pendingItem = { id: 50, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.6, created_at: '2026-08-12T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': pendingItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $10.00 guessed Materials from 2026-08-12.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '  PENDING  ', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"pending" with an item must reply with its prompt');
    const state = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 50, '"PENDING" (any case/whitespace) must set the queue cursor to the oldest item');
  }

  // 20. "skip" advances the cursor to the next item and shows its prompt
  {
    const nextItem = { id: 51, client_id: 1, house_id: 10, amount_guess: 42, category_guess: 'Materials', photo_r2_key: null, raw_text: 'HD $42', confidence: 0.5, created_at: '2026-08-14T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': nextItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $42.00 guessed Materials from 2026-08-14.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'skip', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"skip" must reply with the next item\'s prompt');
    const state = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 51, '"skip" must advance the cursor to the next item after the current one');
  }

  // 21. "skip" past the last item clears the cursor and replies with the empty message
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': null,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 51 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: "You're all caught up." })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'skip', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'skipping the last item must still produce a reply');
    assert((await kv.get('pending_queue:+15551234567')) === null, 'the queue cursor must be cleared once there is nothing left to show');
  }

  // 22. "delete" removes the current item and advances (chains) to the next one
  {
    const nextItem = { id: 51, client_id: 1, house_id: 10, amount_guess: 42, category_guess: 'Materials', photo_r2_key: null, raw_text: 'HD $42', confidence: 0.5, created_at: '2026-08-14T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
      'SELECT * FROM pending_review WHERE client_id = ? AND id > ? ORDER BY id ASC LIMIT 1': nextItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $42.00 guessed Materials from 2026-08-14.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'delete', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"delete" must chain into the next item\'s prompt');
    const deleteCall = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(deleteCall && deleteCall.params[0] === 50, '"delete" must delete the current (cursor) item, not the next one');
    const state = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(state && state.pendingReviewId === 51, '"delete" must advance the cursor to the next item after the deleted one');
  }

  // 23. A house-name match resolves the current item: files it, deletes it, clears the
  // queue cursor (no chaining), and replies with just the filing confirmation.
  {
    const pendingItem = { id: 50, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.6, created_at: '2026-08-12T00:00:00.000Z' };
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE id = ?': pendingItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":11}', copy: 'Logged: $10.00, Materials, 456 Oak Ave.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: '456 Oak', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'a resolved queued item must produce a confirmation SMS body');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the resolved item must be filed under the matched house');
    const pendingDelete = db.calls.find((c) => c.sql.includes('DELETE FROM pending_review'));
    assert(pendingDelete && pendingDelete.params[0] === 50, 'the resolved pending_review row must be deleted');
    assert((await kv.get('pending_queue:+15551234567')) === null, 'resolving an item must clear the queue cursor rather than chaining to the next item');
  }

  // 24. An unrecognized reply while a queue cursor is active leaves it untouched and falls
  // through to normal new-expense processing.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'pending_queue:+15551234567': JSON.stringify({ pendingReviewId: 50 }) });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: '{"house_id":null}', parse: JSON.stringify({ vendor: 'Lowes', amount: 8, category: 'Materials', confidence: 0.9, raw_text: 'Lowes $8' }), copy: 'Logged: $8.00, Materials, Main St.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'Lowes $8 for screws', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, 'an unrecognized queue reply must still produce a normal SMS body from the fallthrough processing');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'an unrecognized queue reply must be processed as a new expense (high confidence, single house)');
  }

  // 25. "pending" overrides an active awaiting_house window from Step 5 (checked first)
  {
    const twoHouses = [singleHouse[0], { id: 11, client_id: 1, address: '456 Oak Ave', nickname: null, google_sheet_id: 'sheet_def' }];
    const pendingItem = { id: 60, client_id: 1, house_id: null, amount_guess: 5, category_guess: 'Other', photo_r2_key: null, raw_text: 'x', confidence: 0.3, created_at: '2026-08-15T00:00:00.000Z' };
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE client_id = ? ORDER BY id ASC LIMIT 1': pendingItem,
    });
    const bucket = createFakeR2Bucket();
    const kv = createFakeKV({ 'awaiting_house:+15551234567': JSON.stringify({ pendingReviewId: 77, attempt: 0 }) });
    const fetchImpl = dispatchFetch([
      ['openrouter.ai', openRouterRouter({ copy: 'Pending: $5.00 guessed Other from 2026-08-15.' })],
    ]);
    const result = await processExpenseMessage({
      fields: { from: '+15551234567', to: '+15559876543', body: 'pending', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket, { CONVERSATION_STATE: kv }),
      deps: { fetchImpl },
    });
    assert(result.smsBody.length > 0, '"pending" must produce the queue prompt even with an active awaiting_house window');
    const queueState = await kv.get('pending_queue:+15551234567', { type: 'json' });
    assert(queueState && queueState.pendingReviewId === 60, '"pending" must set the queue cursor regardless of the pre-existing awaiting_house state');
    const awaitingState = await kv.get('awaiting_house:+15551234567', { type: 'json' });
    assert(awaitingState && awaitingState.pendingReviewId === 77, 'the awaiting_house state must be left untouched, not explicitly cleared, by starting a pending walkthrough');
  }

  console.log('PASS: expense-flow.test.js');
}

await main();
