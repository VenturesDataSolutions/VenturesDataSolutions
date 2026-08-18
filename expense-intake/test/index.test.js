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

  console.log('PASS: index.test.js');
}

await main();
