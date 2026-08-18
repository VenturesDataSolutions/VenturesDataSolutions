import { getCachedReply, cacheReply } from '../src/message-dedup.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // getCachedReply: not yet cached
  const kv1 = createFakeKV();
  const miss = await getCachedReply(kv1, 'SM123');
  assert(miss === null, 'an unprocessed messageSid must return null');

  // cacheReply then getCachedReply: round trip
  const kv2 = createFakeKV();
  await cacheReply(kv2, 'SM456', 'Logged: $42.50, Materials, Main St.');
  const hit = await getCachedReply(kv2, 'SM456');
  assert(hit === 'Logged: $42.50, Materials, Main St.', 'a cached reply must be returned verbatim on the next lookup');

  // cacheReply stores under a processed:<messageSid> key with an expiration, so the
  // namespace doesn't grow forever
  const putCall = kv2.calls.find((c) => c.method === 'put' && c.key === 'processed:SM456');
  assert(putCall, 'cacheReply must store under a processed:<messageSid> key');
  assert(putCall.options && putCall.options.expirationTtl > 0, 'cacheReply must set an expirationTtl so dedup entries do not grow the KV namespace forever');

  // missing messageSid is a no-op, never treated as cached (defensive against a
  // malformed/legacy Twilio payload missing MessageSid entirely)
  const kv3 = createFakeKV();
  await cacheReply(kv3, '', 'should not be stored');
  assert(kv3.calls.every((c) => c.method !== 'put'), 'cacheReply must not write anything for an empty messageSid');
  const emptyLookup = await getCachedReply(kv3, '');
  assert(emptyLookup === null, 'getCachedReply must return null for an empty messageSid without querying KV');
  assert(kv3.calls.every((c) => c.method !== 'get'), 'getCachedReply must not query KV for an empty messageSid');

  console.log('PASS: message-dedup.test.js');
}

await main();
