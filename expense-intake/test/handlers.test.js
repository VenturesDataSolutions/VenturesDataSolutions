// expense-intake/test/handlers.test.js
import crypto from 'node:crypto';
import { handleSmsWebhook } from '../src/handlers.js';
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

function fakeFetch(ok, status, body) {
  return async () => ({ ok, status, body });
}

async function main() {
  const authToken = 'test_auth_token';
  const url = 'https://expense-intake.example.com/sms';

  // invalid signature -> 403, nothing stored
  const rejectedBucket = createFakeR2Bucket();
  let result = await handleSmsWebhook({
    url, bodyText: 'From=%2B1555&To=%2B1556&Body=hi&NumMedia=0', signature: 'bad-sig',
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(0)), bucket: rejectedBucket,
  });
  assert(result.status === 403, 'an invalid signature must return 403');
  assert(rejectedBucket._store.size === 0, 'nothing should be stored when the signature is invalid');

  // valid signature, text-only -> 200, TwiML, nothing stored
  const textParams = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0' };
  const textBody = new URLSearchParams(textParams).toString();
  const textSig = computeTwilioSignature(url, textParams, authToken);
  const textBucket = createFakeR2Bucket();
  result = await handleSmsWebhook({
    url, bodyText: textBody, signature: textSig,
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(0)), bucket: textBucket,
  });
  assert(result.status === 200 && result.contentType === 'text/xml' && result.body.includes('<Response>'), 'a text-only message must return 200 with TwiML');
  assert(textBucket._store.size === 0, 'a text-only message must not store anything to R2');

  // valid signature, with photo -> 200, photo stored
  const photoParams = {
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
  };
  const photoBody = new URLSearchParams(photoParams).toString();
  const photoSig = computeTwilioSignature(url, photoParams, authToken);
  const photoBucket = createFakeR2Bucket();
  const photoFetch = fakeFetch(true, 200, { fake: 'stream' });
  result = await handleSmsWebhook({
    url, bodyText: photoBody, signature: photoSig,
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(8)), bucket: photoBucket, fetchImpl: photoFetch,
  });
  assert(result.status === 200, 'a message with a photo must return 200');
  assert(photoBucket._store.size === 1, 'a message with a photo must store exactly one object');

  // valid signature, photo storage fails -> 500, so Twilio retries delivery
  const failParams = {
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME_missing', MediaContentType0: 'image/jpeg',
  };
  const failBody = new URLSearchParams(failParams).toString();
  const failSig = computeTwilioSignature(url, failParams, authToken);
  const failFetch = fakeFetch(false, 404, null);
  const failBucket = createFakeR2Bucket();
  result = await handleSmsWebhook({
    url, bodyText: failBody, signature: failSig,
    accountSid: 'AC_test', authToken, imagesBinding: createFakeImagesBinding(new ArrayBuffer(8)), bucket: failBucket, fetchImpl: failFetch,
  });
  assert(result.status === 500, 'a failed photo storage must return 500 so Twilio retries delivery');
  assert(failBucket._store.size === 0, 'nothing should be stored in R2 when photo storage fails');

  console.log('PASS: handlers.test.js');
}

await main();
