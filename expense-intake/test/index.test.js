import crypto from 'node:crypto';
import workerModule from '../src/index.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function computeTwilioSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

async function main() {
  // unrouted requests still 404
  let request = new Request('https://expense-intake.example.com/', { method: 'GET' });
  let response = await workerModule.fetch(request, {});
  assert(response.status === 404, 'unrouted requests should 404');

  const authToken = 'test_auth_token';
  const smsUrl = 'https://expense-intake.example.com/sms';
  function baseEnv(overrides = {}) {
    return {
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: authToken,
      IMAGES: createFakeImagesBinding(new ArrayBuffer(0)),
      RECEIPTS_BUCKET: createFakeR2Bucket(),
      DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }),
      CONVERSATION_STATE: createFakeKV(),
      ...overrides,
    };
  }

  // POST /sms with an invalid signature is rejected, through the real routing layer
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'not-a-real-signature' },
    body: 'From=%2B15551234567&To=%2B15559876543&Body=hello&NumMedia=0',
  });
  response = await workerModule.fetch(request, baseEnv());
  assert(response.status === 403, 'an invalid Twilio signature must be rejected with 403 through the real route');

  // POST /sms, text-only message with a valid signature, unknown client -> silent TwiML ack
  const textParams = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0', MessageSid: 'SM_index_text' };
  const textSig = computeTwilioSignature(smsUrl, textParams, authToken);
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': textSig },
    body: new URLSearchParams(textParams).toString(),
  });
  response = await workerModule.fetch(request, baseEnv());
  assert(response.status === 200, 'a validly signed text-only message should return 200 through the real route');
  assert(response.headers.get('Content-Type') === 'text/xml', 'the response to Twilio must be TwiML (text/xml)');
  const textBody = await response.text();
  assert(textBody.includes('<Response>'), 'the response body must be valid (if minimal) TwiML');

  // GET /receipts/:key through the real routing layer
  const receiptBucket = createFakeR2Bucket();
  await receiptBucket.put('receipts/x/1.jpg', new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
  request = new Request('https://expense-intake.example.com/receipts/' + encodeURIComponent('receipts/x/1.jpg'), { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv({ RECEIPTS_BUCKET: receiptBucket }));
  assert(response.status === 200 && response.headers.get('Content-Type') === 'image/jpeg', 'a stored receipt photo must be served through the real GET /receipts/:key route');

  // GET /receipts/:key for a missing key -> 404
  request = new Request('https://expense-intake.example.com/receipts/' + encodeURIComponent('receipts/nope.jpg'), { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv());
  assert(response.status === 404, 'a missing receipt key must 404 through the real route');

  // GET /contact-card/:clientId through the real routing layer
  const contactCardDb = createFakeD1({ 'SELECT * FROM clients WHERE id = ?': { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' } });
  request = new Request('https://expense-intake.example.com/contact-card/1', { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv({ DB: contactCardDb }));
  assert(response.status === 200 && response.headers.get('Content-Type') === 'text/vcard', 'a valid client id must serve a vCard through the real GET /contact-card/:clientId route');

  // GET /contact-card/:clientId for an unknown client -> 404
  request = new Request('https://expense-intake.example.com/contact-card/999', { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv({ DB: createFakeD1({ 'SELECT * FROM clients WHERE id = ?': null }) }));
  assert(response.status === 404, 'an unknown client id must 404 through the real route');

  // scheduled(): the daily purge cron deletes expired pending_review rows through the real handler
  const purgeDb = createFakeD1({ 'DELETE FROM pending_review WHERE expires_at < ?': { success: true, meta: { changes: 2 } } });
  await workerModule.scheduled({ cron: '0 3 * * *' }, baseEnv({ DB: purgeDb }), {});
  assert(purgeDb.calls.some((c) => c.sql.includes('DELETE FROM pending_review')), 'the daily purge cron must delete expired pending_review rows through the real scheduled handler');

  // scheduled(): the monthly nudge cron routes to sendMonthlyNudges through the real handler.
  // No active clients have pending items in this fake DB, so sendMonthlyNudges returns before
  // ever calling generateSmsCopy/sendSms — this test only proves the cron-string dispatch is
  // wired correctly, not the nudge-sending logic itself (that's Task 36's scheduled.test.js).
  const nudgeDb = createFakeD1({
    "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": [],
  });
  await workerModule.scheduled({ cron: '0 9 1 * *' }, baseEnv({ DB: nudgeDb }), {});
  assert(nudgeDb.calls.some((c) => c.sql.includes('COUNT(pr.id)')), 'the monthly nudge cron must query for active clients with pending items through the real scheduled handler');

  // scheduled(): an unrecognized cron string must not throw
  let threwUnrecognized = false;
  try {
    await workerModule.scheduled({ cron: '* * * * *' }, baseEnv({ DB: createFakeD1() }), {});
  } catch {
    threwUnrecognized = true;
  }
  assert(!threwUnrecognized, 'an unrecognized cron string must be logged, not thrown, so a Worker misconfiguration cannot crash a scheduled invocation');

  console.log('PASS: index.test.js');
}

await main();
