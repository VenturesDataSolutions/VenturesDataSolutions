// expense-intake/test/gmail-poll.test.js
import crypto from 'node:crypto';
import { processGmailMessage, pollGmailInbox } from '../src/gmail-poll.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

// Same pattern as test/email-handlers.test.js's generateTestServiceAccount: fileExpense (via
// processResolvedExpenseMessage, reused unchanged from the SMS/Cloudflare-email pipeline) calls
// getGoogleAccessToken, which needs a real RSA keypair to sign a JWT with, even though the
// token-exchange call itself is mocked below.
function generateTestServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { client_email: 'test-sa@test.iam.gserviceaccount.com', private_key: privateKey };
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

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

function buildRawMime({ from, to, subject, messageId, textBody, attachmentBase64 }) {
  const boundary = 'BOUNDARY123';
  const headerLines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`];
  if (messageId) headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [...headerLines, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody, ''];
  if (attachmentBase64) {
    parts.push(
      `--${boundary}`, 'Content-Type: image/jpeg; name="receipt.jpg"', 'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="receipt.jpg"', '', attachmentBase64, ''
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

function buildDeeplyNestedMime(depth) {
  let body = 'Content-Type: text/plain\r\n\r\nleaf content\r\n';
  for (let i = 0; i < depth; i++) {
    const boundary = `B${i}`;
    body = `--${boundary}\r\n${body}--${boundary}--\r\n`;
    body = `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${body}`;
  }
  return `From: owner@acme.com\r\nTo: venturesdatasolutions@gmail.com\r\nSubject: bomb\r\n${body}`;
}

function createThrowingImagesBinding() {
  return {
    input() { throw new Error('IMAGES unavailable'); },
  };
}

function createDbThrowingOnHouses(responses) {
  const base = createFakeD1(responses);
  return {
    calls: base.calls,
    prepare(sql) {
      if (sql.startsWith('SELECT * FROM houses')) {
        return {
          bind() { return this; },
          async all() { throw new Error('DB unavailable'); },
          async first() { throw new Error('DB unavailable'); },
        };
      }
      return base.prepare(sql);
    },
  };
}

function baseEnv(db, overrides = {}) {
  return {
    DB: db,
    RECEIPTS_BUCKET: createFakeR2Bucket(),
    IMAGES: createFakeImagesBinding(new ArrayBuffer(4)),
    CONVERSATION_STATE: createFakeKV(),
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    GOOGLE_SERVICE_ACCOUNT_JSON: generateTestServiceAccount(),
    WORKER_BASE_URL: 'https://expense-intake.example.workers.dev',
    RECEIPTS_EMAIL_ADDRESS: 'venturesdatasolutions@gmail.com',
    ...overrides,
  };
}

function getRawHandler(raw) {
  return ['format=raw', jsonOk({ raw: base64UrlEncode(Buffer.from(raw, 'utf8')) })];
}

async function main() {
  const client = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];
  const twoHouses = [
    singleHouse[0],
    { id: 11, client_id: 1, address: '456 Oak Ave', nickname: 'Oak Ave', google_sheet_id: 'sheet_def' },
  ];

  // 1. Valid receipt email, with a photo attachment, from a recognized EMAIL-ONLY sender
  // -> files the expense, sends a threaded confirmation reply, marks the message read
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 7, client_id: 1, phone_number: null, email: 'owner@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const env = baseEnv(db);
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'venturesdatasolutions@gmail.com',
      subject: 'Receipt', messageId: '<msg1@acme.com>', textBody: 'Home Depot receipt attached',
      attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const fetchImpl = dispatchFetch([
      getRawHandler(raw),
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.sheets', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        copy: 'Logged: $42.50, Materials, Main St.',
      })],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent1' })],
    ]);

    await processGmailMessage({ messageId: 'm1', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a valid receipt email must insert an expenses row');
    assert(expenseInsert.params[8] === null && expenseInsert.params[9] === 'owner@acme.com', 'the expense must be logged under logged_by_email, not logged_by_phone');
    const sendCall = fetchImpl.calls.find((c) => c.url.includes('/messages/send'));
    assert(sendCall, 'a confirmation reply must be sent');
    const sentBody = JSON.parse(sendCall.init.body);
    assert(sentBody.raw, 'the send call must carry a base64url-encoded raw message');
    const decodedReply = Buffer.from(sentBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert(decodedReply.includes('To: owner@acme.com'), 'the reply must be addressed back to the sender');
    assert(decodedReply.includes('In-Reply-To: <msg1@acme.com>'), 'the reply must thread via In-Reply-To when the inbound message has a Message-ID');
    assert(decodedReply.includes('Auto-Submitted: auto-replied'), "every outbound reply must be marked Auto-Submitted: auto-replied so it can't itself trigger a reply-loop");
    const modifyCall = fetchImpl.calls.find((c) => c.url.includes('/modify'));
    assert(modifyCall, 'the message must be marked read after successful processing');
    const cachedReply = await env.CONVERSATION_STATE.get('processed:m1');
    assert(cachedReply === 'Logged: $42.50, Materials, Main St.', 'the reply must be cached under the Gmail message id for dedup');
  }

  // 2. Unrecognized sender -> a reply with the standard rejection text is sent, message marked
  // read (terminal classification, not worth retrying), no D1 writes
  {
    const db = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const env = baseEnv(db);
    const raw = buildRawMime({
      from: 'stranger@example.com', to: 'venturesdatasolutions@gmail.com',
      subject: 'Receipt', messageId: '<msg2@example.com>', textBody: 'some text',
    });
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})], ['/messages/send', jsonOk({ id: 'sent2' })]]);

    await processGmailMessage({ messageId: 'm2', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    assert(!db.calls.some((c) => c.sql.includes('INSERT')), 'no writes of any kind must happen for an unrecognized sender');
    const sendCall = fetchImpl.calls.find((c) => c.url.includes('/messages/send'));
    assert(sendCall, 'an unrecognized sender must still get a reply explaining why, since Gmail cannot SMTP-reject an already-delivered message');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'an unrecognized sender is a terminal classification and must be marked read');
  }

  // 3. Ambiguous house -> clarification reply sent + marked read; a follow-up poll for the
  // same sender address (matched by KV state, not headers) resolves it
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 8, client_id: 1, phone_number: null, email: 'multi@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE id = ?': { id: 1, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.95 },
    });
    const kv = createFakeKV();
    const env = baseEnv(db, { CONVERSATION_STATE: kv });

    const firstRaw = buildRawMime({ from: 'multi@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Receipt', messageId: '<msg3@acme.com>', textBody: 'Lowes $10' });
    const firstFetch = dispatchFetch([
      getRawHandler(firstRaw),
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        copy: 'Which house is this for?',
      })],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent3' })],
    ]);
    await processGmailMessage({ messageId: 'm3', accessToken: 'ya29.tok', env, deps: { fetchImpl: firstFetch } });

    assert(firstFetch.calls.some((c) => c.url.includes('/messages/send')), 'an ambiguous house must still produce a clarification reply');
    const awaitingHouseCall = kv.calls.find((c) => c.method === 'put' && c.key === 'awaiting_house:multi@acme.com');
    assert(awaitingHouseCall, 'an ambiguous house must open an awaiting_house KV state keyed by the sender EMAIL address');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'an ambiguous house must not file anything yet');

    const secondRaw = buildRawMime({
      from: 'multi@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Re: Receipt', messageId: '<msg4@acme.com>',
      textBody: 'Oak Ave\n\nOn Mon wrote:\n> Which house is this for?',
    });
    const secondFetch = dispatchFetch([
      getRawHandler(secondRaw),
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.sheets', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_def', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: JSON.stringify({ house_id: 11 }), copy: 'Logged: $10.00, Materials, Oak Ave.' })],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent4' })],
    ]);
    await processGmailMessage({ messageId: 'm4', accessToken: 'ya29.tok', env, deps: { fetchImpl: secondFetch } });

    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the follow-up reply must file the expense under the house it named (Oak Ave, house_id 11)');
  }

  // 4. Malformed MIME that postal-mime cannot parse -> logged and marked read, no reply (the
  // sender address can't even be extracted), no D1 access, no throw (this runs on a fully
  // public, pre-authentication path)
  {
    const db = createFakeD1();
    const env = baseEnv(db);
    const raw = buildDeeplyNestedMime(300);
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})]]);

    let threw = false;
    try {
      await processGmailMessage({ messageId: 'm5', accessToken: 'ya29.tok', env, deps: { fetchImpl } });
    } catch {
      threw = true;
    }
    assert(!threw, 'a MIME parse failure must never throw — it must be caught and the message dropped gracefully');
    assert(db.calls.length === 0, 'no DB access at all must happen when the email cannot even be parsed');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/messages/send')), 'no reply can be sent when parsing fails, since the sender address cannot be extracted');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'a permanently unparseable message must still be marked read so it does not retry forever');
  }

  // 5. A transient photo-storage failure (R2/Images hiccup) must propagate (throw), leaving the
  // message unread so the next poll retries it automatically — no reply is sent since nothing
  // is final yet
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 9, client_id: 1, phone_number: null, email: 'owner2@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const env = baseEnv(db, { IMAGES: createThrowingImagesBinding() });
    const raw = buildRawMime({
      from: 'owner2@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Receipt', messageId: '<msg5@acme.com>',
      textBody: 'Home Depot receipt attached', attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})], ['/messages/send', jsonOk({ id: 'sent5' })]]);

    let threw = false;
    try {
      await processGmailMessage({ messageId: 'm6', accessToken: 'ya29.tok', env, deps: { fetchImpl } });
    } catch {
      threw = true;
    }
    assert(threw, 'a transient photo-storage failure must propagate so the caller leaves the message unread for a retry');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'nothing must be filed when photo storage fails');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/modify')), 'a transient failure must NOT mark the message read — that would prevent the automatic retry');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/messages/send')), 'no reply must be sent on a transient failure — the retry itself is silent');
  }

  // 6. A transient processing failure (e.g. a Sheets API blip) must also propagate
  {
    const db = createDbThrowingOnHouses({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 10, client_id: 1, phone_number: null, email: 'owner3@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
    });
    const env = baseEnv(db);
    const raw = buildRawMime({ from: 'owner3@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Receipt', messageId: '<msg6@acme.com>', textBody: 'Home Depot $20' });
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})]]);

    let threw = false;
    try {
      await processGmailMessage({ messageId: 'm7', accessToken: 'ya29.tok', env, deps: { fetchImpl } });
    } catch {
      threw = true;
    }
    assert(threw, 'a transient processing failure must propagate so the caller leaves the message unread for a retry');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/modify')), 'a transient failure must not be marked read');
  }

  // 7. An auto-generated inbound message (Auto-Submitted header) is dropped: not processed, not
  // replied to (replying risks a mail loop), but IS marked read so it doesn't retry forever
  {
    const db = createFakeD1();
    const env = baseEnv(db);
    const boundary = 'BOUNDARY123';
    const raw = [
      'From: owner@acme.com', 'To: venturesdatasolutions@gmail.com', 'Subject: Out of office',
      'Message-ID: <auto1@acme.com>', 'Auto-Submitted: auto-replied',
      `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', 'I am out of office.', '',
      `--${boundary}--`, '',
    ].join('\r\n');
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})]]);

    await processGmailMessage({ messageId: 'm8', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    assert(db.calls.length === 0, 'an auto-submitted message must never reach sender/client resolution or any DB access');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/messages/send')), 'an auto-submitted message must never get a reply — replying risks a mail loop');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'an auto-submitted message must still be marked read so it does not retry forever');
  }

  // 8. An already-cached message id (a prior poll filed it but a later step, e.g. markMessageRead,
  // never completed) is not reprocessed — just marked read
  {
    const db = createFakeD1();
    const kv = createFakeKV({ 'processed:m9': 'Logged: $5.00, Materials, Main St.' });
    const env = baseEnv(db, { CONVERSATION_STATE: kv });
    const fetchImpl = dispatchFetch([['/modify', jsonOk({})]]);

    await processGmailMessage({ messageId: 'm9', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    assert(db.calls.length === 0, 'an already-cached message must not touch the DB at all');
    assert(!fetchImpl.calls.some((c) => c.url.includes('format=raw')), 'an already-cached message must not even be re-fetched');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'an already-cached message must still be marked read');
  }

  // pollGmailInbox: processes each listed message, isolating one message's failure from the
  // rest of the batch
  {
    const db = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const env = baseEnv(db, { GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csec', GMAIL_REFRESH_TOKEN: 'rtok' });
    const raw1 = buildRawMime({ from: 'a@x.com', to: 'venturesdatasolutions@gmail.com', subject: 'r1', messageId: '<a@x.com>', textBody: 'hi' });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', expires_in: 3600 })],
      ['gmail.googleapis.com/gmail/v1/users/me/messages?', jsonOk({ messages: [{ id: 'good' }, { id: 'bad' }] })],
      [`messages/good?format=raw`, jsonOk({ raw: base64UrlEncode(Buffer.from(raw1, 'utf8')) })],
      [`messages/bad?format=raw`, async () => { throw new Error('network blip'); }],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent' })],
    ]);

    const result = await pollGmailInbox(env, { fetchImpl });
    assert(result.messageCount === 2, 'must report the total number of messages listed');
    assert(result.processedCount === 1, "one message's failure must not prevent the other from being processed");
  }

  console.log('PASS: gmail-poll.test.js');
}

await main();
