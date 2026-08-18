// expense-intake/test/expense-flow.test.js
import crypto from 'node:crypto';
import { processExpenseMessage } from '../src/expense-flow.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';

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
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc' })],
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
        // Only the parse call should fail in this scenario — the subsequent
        // generateSmsCopy('low_confidence', ...) call must still succeed, since this
        // test is isolating "parseExpense fails" from "generateSmsCopy fails" (scenario 9,
        // below, covers the latter — safeGenerateSmsCopy's fallback path).
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
  // pipeline must still complete with fallback copy, not throw — a throw here would mean
  // nothing gets cached (Task 16) and Twilio would retry, re-writing a second Sheet row and
  // a second expenses row for a receipt that was already successfully filed. This is the
  // Critical gap the whole-step review caught: safeGenerateSmsCopy's fallback is what
  // closes it.
  {
    const db = createFakeD1({
      'SELECT * FROM clients WHERE twilio_number = ?': client,
      'SELECT * FROM authorized_senders WHERE client_id = ? AND phone_number = ?': sender,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const bucket = createFakeR2Bucket();
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc' })],
      ['openrouter.ai', async (url, init) => {
        const body = JSON.parse(init.body);
        const isParse = body.messages.some((m) => Array.isArray(m.content));
        if (isParse) {
          return { ok: true, status: 200, json: async () => chatResponse(JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' })) };
        }
        // The copy-generation call fails — this is the exact scenario the fallback exists for
        return { ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) };
      }],
    ]);
    const result = await processExpenseMessage({
      // Non-empty body (rather than '') so this doesn't trip the module's own
      // `!fields.body && !photoR2Key` early-return guard before reaching the write path —
      // the mock's canned parse response doesn't depend on the actual text content.
      fields: { from: '+15551234567', to: '+15559876543', body: 'HD $42.50', media: [] },
      photoR2Key: null,
      env: baseEnv(db, bucket),
      deps: { fetchImpl },
    });
    assert(result.smsBody === 'Logged: $42.50, Materials, Main St.', 'a generateSmsCopy failure after a successful write must fall back to static confirmation copy with the real values substituted, not throw');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'the write must have already succeeded before the copy-generation failure — this proves the fallback path is reached post-write, not a case where the write itself was skipped');
  }

  // 10. generateSmsCopy fails on the ambiguous-house (house_selection) path: must still
  // fall back to static copy, and the pending_review write (house_id null) must have
  // already happened. Mirrors scenario 9 but for the house_selection call site.
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
        // The copy-generation call fails — this is the exact scenario the fallback exists for
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
  // happened. Mirrors scenario 9 but for the low_confidence call site.
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
        // The copy-generation call fails — this is the exact scenario the fallback exists for
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

  console.log('PASS: expense-flow.test.js');
}

await main();
