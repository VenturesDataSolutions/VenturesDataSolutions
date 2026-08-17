// expense-intake/test/index.test.js
import crypto from 'node:crypto';
import workerModule from '../src/index.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';

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
  function baseEnv(imagesBinding, bucket) {
    return {
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: authToken,
      IMAGES: imagesBinding,
      RECEIPTS_BUCKET: bucket,
    };
  }

  // POST /sms with an invalid signature is rejected, through the real routing layer
  const rejectedBucket = createFakeR2Bucket();
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'not-a-real-signature' },
    body: 'From=%2B15551234567&To=%2B15559876543&Body=hello&NumMedia=0',
  });
  response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(0)), rejectedBucket));
  assert(response.status === 403, 'an invalid Twilio signature must be rejected with 403 through the real route');

  // POST /sms, text-only message with a valid signature, through the real routing layer
  const textParams = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0' };
  const textSig = computeTwilioSignature(smsUrl, textParams, authToken);
  const textBucket = createFakeR2Bucket();
  request = new Request(smsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': textSig },
    body: new URLSearchParams(textParams).toString(),
  });
  response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(0)), textBucket));
  assert(response.status === 200, 'a validly signed text-only message should return 200 through the real route');
  assert(response.headers.get('Content-Type') === 'text/xml', 'the response to Twilio must be TwiML (text/xml)');
  const textBody = await response.text();
  assert(textBody.includes('<Response>'), 'the response body must be valid (if minimal) TwiML');
  assert(textBucket._store.size === 0, 'a text-only message must not store anything to R2');

  // POST /sms, message with a photo and a valid signature — the one case that needs a
  // network-shaped fetch (Twilio media fetch), so globalThis.fetch is monkey-patched,
  // same pattern worker/test/index.test.js already uses for its /checkout and /portal-link tests.
  const photoParams = {
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
  };
  const photoSig = computeTwilioSignature(smsUrl, photoParams, authToken);
  const photoBucket = createFakeR2Bucket();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, body: { fake: 'twilio-media-stream' } });
  try {
    request = new Request(smsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': photoSig },
      body: new URLSearchParams(photoParams).toString(),
    });
    response = await workerModule.fetch(request, baseEnv(createFakeImagesBinding(new ArrayBuffer(8)), photoBucket));
    assert(response.status === 200, 'a validly signed photo message should return 200 through the real route');
    assert(photoBucket._store.size === 1, 'a message with a photo must store exactly one object to R2 through the real route');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('PASS: index.test.js');
}

await main();
