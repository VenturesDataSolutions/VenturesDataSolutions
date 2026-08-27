// expense-intake/test/gmail-auth.test.js
import { getGmailAccessToken } from '../src/gmail-auth.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // cache hit: returns the cached token, makes no network call at all
  {
    const kv = createFakeKV({ gmail_access_token: 'ya29.cached' });
    const fetchImpl = fakeFetch(true, 200, {});
    const token = await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    assert(token === 'ya29.cached', 'a cached token must be returned as-is');
    assert(fetchImpl.calls.length === 0, 'a cache hit must not call the network at all');
  }

  // cache miss: exchanges the refresh token, caches the result with a safety-margined TTL
  {
    const kv = createFakeKV();
    const fetchImpl = fakeFetch(true, 200, { access_token: 'ya29.fresh', token_type: 'Bearer', expires_in: 3600 });
    const token = await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    assert(token === 'ya29.fresh', 'a cache miss must return the freshly exchanged access token');

    const call = fetchImpl.calls[0];
    assert(call.url === 'https://oauth2.googleapis.com/token', 'must POST to the Google token endpoint');
    const bodyParams = new URLSearchParams(call.init.body);
    assert(bodyParams.get('grant_type') === 'refresh_token', 'must use the refresh_token grant type');
    assert(bodyParams.get('client_id') === 'cid', 'must send the client id');
    assert(bodyParams.get('client_secret') === 'csec', 'must send the client secret');
    assert(bodyParams.get('refresh_token') === 'rtok', 'must send the refresh token');

    const putCall = kv.calls.find((c) => c.method === 'put');
    assert(putCall && putCall.key === 'gmail_access_token' && putCall.value === 'ya29.fresh', 'the fresh token must be cached under a fixed KV key');
    assert(putCall.options.expirationTtl === 3600 - 120, 'the cache TTL must be the token lifetime minus a safety margin, so a near-expiry token is never handed out');
  }

  // missing expires_in: falls back to a 3600s default before applying the safety margin
  {
    const kv = createFakeKV();
    const fetchImpl = fakeFetch(true, 200, { access_token: 'ya29.noexpiry', token_type: 'Bearer' });
    const token = await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    assert(token === 'ya29.noexpiry', 'must still return the fresh token when expires_in is absent');

    const putCall = kv.calls.find((c) => c.method === 'put');
    assert(putCall && putCall.options.expirationTtl === 3600 - 120, 'must default to a 3600s lifetime when expires_in is missing');
  }

  // kv.put failure: a KV write hiccup must not discard an already-successful token exchange
  {
    const kv = createFakeKV();
    kv.put = async () => { throw new Error('KV unavailable'); };
    const fetchImpl = fakeFetch(true, 200, { access_token: 'ya29.uncached', token_type: 'Bearer', expires_in: 3600 });
    const token = await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    assert(token === 'ya29.uncached', 'a kv.put failure must not prevent returning the freshly exchanged token');
  }

  // error path: Google rejects the refresh -> throws with the error_description
  {
    const kv = createFakeKV();
    const fetchImpl = fakeFetch(false, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    let threw = false;
    try {
      await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    } catch (err) {
      threw = true;
      assert(err.message === 'Token has been expired or revoked.', "must surface Google's error_description");
    }
    assert(threw, 'a non-2xx token response must throw');
  }

  console.log('PASS: gmail-auth.test.js');
}

await main();
