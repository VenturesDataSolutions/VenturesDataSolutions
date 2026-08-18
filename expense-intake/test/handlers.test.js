import crypto from 'node:crypto';
import { handleSmsWebhook, handleGetReceipt } from '../src/handlers.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeKV } from './fake-kv.js';
import { getCachedReply } from '../src/message-dedup.js';

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
  return async () => ({ ok, status, json: async () => body });
}

// Mirrors the throwingDb pattern already used above (D1-failure, cache-hit-skips-D1): a
// binding that blows up if actually invoked, so a test can assert it was never touched.
function createThrowingR2Bucket() {
  return {
    async get() { throw new Error('R2 should never be read on a dedup cache hit'); },
    async put() { throw new Error('R2 should never be written on a dedup cache hit'); },
  };
}

function createThrowingImagesBinding() {
  return {
    input() { throw new Error('IMAGES should never be invoked on a dedup cache hit'); },
  };
}

function baseEnv(overrides = {}) {
  return {
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'test_auth_token',
    IMAGES: createFakeImagesBinding(new ArrayBuffer(0)),
    RECEIPTS_BUCKET: createFakeR2Bucket(),
    DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }),
    CONVERSATION_STATE: createFakeKV(),
    ...overrides,
  };
}

async function main() {
  const url = 'https://expense-intake.example.com/sms';
  const authToken = 'test_auth_token';

  // invalid signature -> 403, nothing stored, processExpenseMessage never reached
  {
    const env = baseEnv();
    const result = await handleSmsWebhook({
      url, bodyText: 'From=%2B1555&To=%2B1556&Body=hi&NumMedia=0', signature: 'bad-sig', env,
    });
    assert(result.status === 403, 'an invalid signature must return 403');
  }

  // valid signature, unknown client -> 200, empty TwiML (silent ack from processExpenseMessage);
  // also confirms a successful (even silently-empty) response gets cached under its messageSid
  {
    const params = { From: '+15551234567', To: '+19998887777', Body: 'hello', NumMedia: '0', MessageSid: 'SM_unknown_client' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const kv = createFakeKV();
    const env = baseEnv({ DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }), CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 200 && result.contentType === 'text/xml' && result.body === '<Response></Response>', 'an unrecognized client must still 200 with an empty TwiML acknowledgment');
    const cached = await getCachedReply(kv, 'SM_unknown_client');
    assert(cached === '', 'a successfully-handled message (even a silent ack) must be cached under its messageSid so a Twilio retry replays it instead of reprocessing');
  }

  // photo storage failure -> 500, processExpenseMessage never reached, and nothing gets
  // cached (a failed attempt must be retryable for real, not permanently marked "done")
  {
    const params = {
      From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME_missing', MediaContentType0: 'image/jpeg', MessageSid: 'SM_photo_fail',
    };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const failBucket = createFakeR2Bucket();
    const kv = createFakeKV();
    const env = baseEnv({ RECEIPTS_BUCKET: failBucket, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env, deps: { fetchImpl: fakeFetch(false, 404, null) } });
    assert(result.status === 500, 'a failed photo storage must still return 500 so Twilio retries delivery');
    assert(failBucket._store.size === 0, 'nothing should be stored in R2 when photo storage fails');
    assert((await getCachedReply(kv, 'SM_photo_fail')) === null, 'a failed attempt must not be cached, so a real Twilio retry can actually retry it');
  }

  // processExpenseMessage throwing -> 500 (e.g. a house with no google_sheet_id, or a DB
  // outage), and nothing gets cached, same reasoning as the photo-storage-failure case
  {
    const params = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0', MessageSid: 'SM_process_fail' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const throwingDb = {
      prepare() {
        return { bind() { return this; }, async first() { throw new Error('DB unavailable'); } };
      },
    };
    const kv = createFakeKV();
    const env = baseEnv({ DB: throwingDb, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 500, 'an unexpected error while processing the message must return 500, not crash the Worker');
    assert((await getCachedReply(kv, 'SM_process_fail')) === null, 'a failed attempt must not be cached');
  }

  // repeated MessageSid (Twilio retry after we already fully processed it) -> replay the
  // cached reply without touching D1/R2/the AI provider at all
  {
    const params = { From: '+15551234567', To: '+15559876543', Body: 'hello', NumMedia: '0', MessageSid: 'SM_retry_test' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const throwingDb = {
      prepare() {
        throw new Error('D1 should never be queried on a dedup cache hit');
      },
    };
    const kv = createFakeKV({ 'processed:SM_retry_test': 'Logged: $42.50, Materials, Main St.' });
    const env = baseEnv({ DB: throwingDb, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 200 && result.contentType === 'text/xml', 'a cache hit must still return 200 TwiML');
    assert(result.body === '<Response><Message>Logged: $42.50, Materials, Main St.</Message></Response>', 'a cache hit must replay the exact cached reply');
  }

  // repeated MessageSid for an MMS (photo) message -> the dedup check must short-circuit
  // BEFORE the photo-storage step, not just before processExpenseMessage. Uses bindings that
  // throw if ever invoked so a regression in that ordering (checking media before the cache)
  // would fail loudly instead of silently re-storing a photo that's already been filed.
  {
    const params = {
      From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME_already_processed', MediaContentType0: 'image/jpeg',
      MessageSid: 'SM_retry_with_media',
    };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const throwingBucket = createThrowingR2Bucket();
    const throwingImages = createThrowingImagesBinding();
    const kv = createFakeKV({ 'processed:SM_retry_with_media': 'Logged: $18.00, Materials, Main St.' });
    const env = baseEnv({ RECEIPTS_BUCKET: throwingBucket, IMAGES: throwingImages, CONVERSATION_STATE: kv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 200 && result.contentType === 'text/xml', 'a cache hit on an MMS message must still return 200 TwiML');
    assert(result.body === '<Response><Message>Logged: $18.00, Materials, Main St.</Message></Response>', 'a cache hit on an MMS message must replay the exact cached reply, not attempt to re-store the photo');
  }

  // a KV write failure while caching the reply (cacheReply's inner try/catch) must be
  // swallowed, not propagate and turn a successful response into a 500
  {
    const params = { From: '+15551234567', To: '+19998887777', Body: 'hello', NumMedia: '0', MessageSid: 'SM_cache_write_fails' };
    const bodyText = new URLSearchParams(params).toString();
    const signature = computeTwilioSignature(url, params, authToken);
    const flakyKv = createFakeKV();
    flakyKv.put = async () => { throw new Error('KV unavailable'); };
    const env = baseEnv({ DB: createFakeD1({ 'SELECT * FROM clients WHERE twilio_number = ?': null }), CONVERSATION_STATE: flakyKv });
    const result = await handleSmsWebhook({ url, bodyText, signature, env });
    assert(result.status === 200 && result.contentType === 'text/xml' && result.body === '<Response></Response>', 'a KV failure while caching the reply must be swallowed, still returning the normal successful response');
  }

  // handleGetReceipt: found
  {
    const bucket = createFakeR2Bucket();
    await bucket.put('receipts/x/1.jpg', new ArrayBuffer(4), { httpMetadata: { contentType: 'image/jpeg' } });
    const found = await handleGetReceipt({ key: 'receipts/x/1.jpg', bucket });
    assert(found.status === 200 && found.contentType === 'image/jpeg', 'a stored photo must be served with its stored content type');
  }

  // handleGetReceipt: not found
  {
    const bucket = createFakeR2Bucket();
    const missing = await handleGetReceipt({ key: 'receipts/nope.jpg', bucket });
    assert(missing.status === 404, 'a missing key must 404');
  }

  console.log('PASS: handlers.test.js');
}

await main();
