import crypto from 'node:crypto';
import { handleEmailWebhook } from '../src/handlers.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeKV } from './fake-kv.js';
import { createFakeEmailMessage } from './fake-email-message.js';
import { createFakeEmailSender } from './fake-email-send.js';

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

// postal-mime turns out to be very lenient about malformed input empirically, an empty
// string, random non-MIME text, and even null bytes all parse "successfully" with empty
// fields rather than throwing. The one input that reliably throws is exceeding its
// maxNestingDepth guard (default 256 levels, see node_modules/postal-mime/dist/mime-node.cjs)
// via deeply nested multipart/mixed parts — a genuinely adversarial MIME payload, and exactly
// the kind of input a public, unauthenticated inbound address needs to be defended against.
function buildDeeplyNestedMime(depth) {
  let body = 'Content-Type: text/plain\r\n\r\nleaf content\r\n';
  for (let i = 0; i < depth; i++) {
    const boundary = `B${i}`;
    body = `--${boundary}\r\n${body}--${boundary}--\r\n`;
    body = `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${body}`;
  }
  return `From: owner@acme.com\r\nTo: receipts@intake.venturesdatasolutions.com\r\nSubject: bomb\r\n${body}`;
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

// Same "throws if actually invoked" spy pattern already used in test/handlers.test.js, for
// forcing storeReceiptPhotoFromBytes to fail so the photo_storage_failed path can be exercised.
function createThrowingImagesBinding() {
  return {
    input() { throw new Error('IMAGES unavailable'); },
  };
}

// Wraps a normal fake D1 but makes the houses lookup throw — used to force
// processResolvedExpenseMessage to fail (simulating a Sheets/DB blip) AFTER the sender and
// client have already resolved successfully, so the processing_failed path can be exercised
// without also tripping the unrecognized-sender/client-not-found paths.
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
    RECEIPTS_EMAIL_ADDRESS: 'receipts@intake.venturesdatasolutions.com',
    EMAIL: createFakeEmailSender(),
    ...overrides,
  };
}

async function main() {
  const client = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];
  const twoHouses = [
    singleHouse[0],
    { id: 11, client_id: 1, address: '456 Oak Ave', nickname: 'Oak Ave', google_sheet_id: 'sheet_def' },
  ];

  // 1. Valid receipt email, with a photo attachment, from a recognized EMAIL-ONLY sender
  // (phone_number null, no sms_consents row exists anywhere in this fake DB) -> logs the
  // expense under logged_by_email and sends a confirmation reply. This is also the proof
  // that the flow works fully independent of any SMS opt-in state.
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 7, client_id: 1, phone_number: null, email: 'owner@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        copy: 'Logged: $42.50, Materials, Main St.',
      })],
    ]);
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg1@acme.com>', textBody: 'Home Depot receipt attached',
      attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const message = createFakeEmailMessage({ from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    const result = await handleEmailWebhook({ message, env, deps: { fetchImpl } });

    assert(result.status === 'sent', 'a valid receipt email from a recognized sender must be processed and replied to');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a valid receipt email must insert an expenses row');
    assert(expenseInsert.params[8] === null && expenseInsert.params[9] === 'owner@acme.com', 'the expense must be logged under logged_by_email, not logged_by_phone');
    assert(!db.calls.some((c) => c.sql.includes('sms_consents')), 'the flow must never query sms_consents for an email-only sender — proves it is independent of any SMS opt-in state');
    assert(emailSender.calls.length === 1 && emailSender.calls[0].to === 'owner@acme.com', 'a confirmation reply must be sent back to the sender');
    assert(emailSender.calls[0].headers && emailSender.calls[0].headers['In-Reply-To'] === '<msg1@acme.com>', 'the reply must thread via In-Reply-To when the inbound message has a Message-ID');
    assert(emailSender.calls[0].headers['Auto-Submitted'] === 'auto-replied', "every outbound reply must be marked Auto-Submitted: auto-replied so it can't itself trigger a reply-loop with an autoresponder");
  }

  // 2. Unrecognized sender -> rejected, no D1 writes, no reply sent
  {
    const db = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    const raw = buildRawMime({
      from: 'stranger@example.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg2@example.com>', textBody: 'some text',
    });
    const message = createFakeEmailMessage({ from: 'stranger@example.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    const result = await handleEmailWebhook({ message, env, deps: {} });

    assert(result.status === 'rejected', 'an email from an unrecognized address must be rejected');
    assert(message._rejections.length === 1, 'setReject must be called exactly once for an unrecognized sender');
    assert(!db.calls.some((c) => c.sql.includes('INSERT')), 'no writes of any kind must happen for an unrecognized sender');
    assert(emailSender.calls.length === 0, 'no reply must be sent for an unrecognized sender');
  }

  // 3. Ambiguous house -> clarification reply sent; a follow-up email from the same address
  // (matched by KV state, not by reply-threading headers) resolves it and files the expense
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 8, client_id: 1, phone_number: null, email: 'multi@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      // The first (ambiguous) email inserts a pending_review row (fake D1's default insert
      // response gives it id 1); the follow-up reply looks that row back up by id to resolve
      // it, so the fake DB needs a canned response for that lookup too.
      'SELECT * FROM pending_review WHERE id = ?': { id: 1, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.95 },
    });
    const kv = createFakeKV();
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { CONVERSATION_STATE: kv, EMAIL: emailSender });

    const firstFetch = dispatchFetch([
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        copy: 'Which house is this for?',
      })],
    ]);
    const firstRaw = buildRawMime({
      from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg3@acme.com>', textBody: 'Lowes $10',
    });
    const firstMessage = createFakeEmailMessage({ from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw: firstRaw });
    const firstResult = await handleEmailWebhook({ message: firstMessage, env, deps: { fetchImpl: firstFetch } });

    assert(firstResult.status === 'sent', 'an ambiguous house must still produce a clarification reply, not a rejection');
    assert(emailSender.calls.length === 1, 'the first (ambiguous) email must trigger exactly one clarification reply');
    const awaitingHouseCall = kv.calls.find((c) => c.method === 'put' && c.key === 'awaiting_house:multi@acme.com');
    assert(awaitingHouseCall, 'an ambiguous house must open an awaiting_house KV state keyed by the sender EMAIL address');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'an ambiguous house must not file anything yet');

    const secondFetch = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', token_type: 'Bearer', expires_in: 3600 })],
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_def', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: JSON.stringify({ house_id: 11 }), copy: 'Logged: $10.00, Materials, Oak Ave.' })],
    ]);
    const secondRaw = buildRawMime({
      from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Re: Receipt', messageId: '<msg4@acme.com>',
      textBody: 'Oak Ave\n\nOn Mon wrote:\n> Which house is this for?',
    });
    const secondMessage = createFakeEmailMessage({ from: 'multi@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw: secondRaw });
    const secondResult = await handleEmailWebhook({ message: secondMessage, env, deps: { fetchImpl: secondFetch } });

    assert(secondResult.status === 'sent', 'the follow-up reply must resolve the ambiguous house');
    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the follow-up reply must file the expense under the house it named (Oak Ave, house_id 11)');
  }

  // 4. Malformed MIME that postal-mime cannot parse -> rejected gracefully, no D1 access at all,
  // no uncaught exception (this runs on a fully public, pre-authentication path)
  {
    const db = createFakeD1();
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    // Verified empirically (see buildDeeplyNestedMime's comment above): an empty string,
    // garbage non-MIME text, and null bytes all parse "successfully" under postal-mime, so
    // none of those reliably exercise the catch block. A MIME payload nested past postal-mime's
    // maxNestingDepth guard (256 levels) does reliably throw, so that's the fixture used here.
    const raw = buildDeeplyNestedMime(300);
    const message = createFakeEmailMessage({ from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    let threw = false;
    let result;
    try {
      result = await handleEmailWebhook({ message, env, deps: {} });
    } catch {
      threw = true;
    }
    assert(!threw, 'a MIME parse failure must never throw out of handleEmailWebhook — it must be caught and turned into a graceful rejection');
    assert(result.status === 'rejected', 'a MIME parse failure must result in a rejection, not a silent success');
    assert(message._rejections.length === 1, 'setReject must be called for a MIME parse failure');
    assert(db.calls.length === 0, 'no DB access at all must happen when the email cannot even be parsed');
    assert(emailSender.calls.length === 0, 'no reply must be sent when the email cannot be parsed');
  }

  // 5. A transient photo-storage failure (R2/Images hiccup) must reject with feedback to the
  // sender, not silently drop the email. Per Cloudflare's Email Routing docs, a handler that
  // returns without consuming/forwarding/rejecting causes the email to vanish with zero
  // feedback — worse than the SMS path, which at least 500s so Twilio retries.
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 9, client_id: 1, phone_number: null, email: 'owner2@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender, IMAGES: createThrowingImagesBinding() });
    const raw = buildRawMime({
      from: 'owner2@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg5@acme.com>', textBody: 'Home Depot receipt attached',
      attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const message = createFakeEmailMessage({ from: 'owner2@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    const result = await handleEmailWebhook({ message, env, deps: {} });

    assert(result.status === 'rejected' && result.reason === 'photo_storage_failed', 'a transient photo-storage failure must be reported as a rejection, not silently dropped');
    assert(message._rejections.length === 1, 'setReject must be called on a photo-storage failure so the sender gets an SMTP-level bounce with feedback');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'nothing must be filed when photo storage fails');
    assert(emailSender.calls.length === 0, 'no confirmation reply must be sent when photo storage fails');
  }

  // 6. A transient processing failure (e.g. a Sheets API blip surfaced by
  // processResolvedExpenseMessage) must also reject with feedback rather than silently drop.
  {
    const db = createDbThrowingOnHouses({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 10, client_id: 1, phone_number: null, email: 'owner3@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
    });
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    const raw = buildRawMime({
      from: 'owner3@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt', messageId: '<msg6@acme.com>', textBody: 'Home Depot $20',
    });
    const message = createFakeEmailMessage({ from: 'owner3@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw });
    const result = await handleEmailWebhook({ message, env, deps: {} });

    assert(result.status === 'rejected' && result.reason === 'processing_failed', 'a transient processing failure must be reported as a rejection, not silently dropped');
    assert(message._rejections.length === 1, 'setReject must be called on a processing failure so the sender gets feedback instead of the email vanishing');
    assert(emailSender.calls.length === 0, 'no confirmation reply must be sent when processing fails');
  }

  // 7. An auto-generated inbound message (vacation autoresponder, bounce, etc.) carrying an
  // Auto-Submitted header other than "no" must be silently dropped: not processed, and — since
  // rejecting would itself bounce back at an autoresponder, the classic mail-loop trigger — not
  // rejected either.
  {
    const db = createFakeD1();
    const emailSender = createFakeEmailSender();
    const env = baseEnv(db, { EMAIL: emailSender });
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Out of office', messageId: '<auto1@acme.com>', textBody: 'I am out of office.',
    });
    const message = createFakeEmailMessage({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com', raw,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    const result = await handleEmailWebhook({ message, env, deps: {} });

    assert(result.status === 'ignored' && result.reason === 'auto_submitted', 'an Auto-Submitted inbound message must be ignored, not processed as a real receipt');
    assert(db.calls.length === 0, 'an auto-submitted message must never reach sender/client resolution or any DB access');
    assert(emailSender.calls.length === 0, 'an auto-submitted message must never get a reply — replying would itself risk a mail loop');
    assert(message._rejections.length === 0, 'an auto-submitted message must not be rejected either — only silently dropped, since bouncing an autoresponder is the classic loop trigger');
  }

  console.log('PASS: email-handlers.test.js');
}

await main();
