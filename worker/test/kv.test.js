// worker/test/kv.test.js
import { getCountyLock, setCountyLock, clearCountyLock, getPricingMode } from '../src/kv.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  const kv = createFakeKV();

  assert((await getCountyLock(kv, '01001')) === null, 'a fresh county should have no lock');
  assert((await getPricingMode(kv)) === 'founding', 'pricing mode should default to founding when unset');

  await setCountyLock(kv, '01001', { customerId: 'cus_1', subscriptionId: 'sub_1', claimedAt: '2026-08-07T00:00:00.000Z' });
  const lock = await getCountyLock(kv, '01001');
  assert(lock && lock.customerId === 'cus_1' && lock.subscriptionId === 'sub_1', 'a lock should round-trip through KV as parsed JSON');

  await clearCountyLock(kv, '01001');
  assert((await getCountyLock(kv, '01001')) === null, 'clearCountyLock should remove the lock');

  await kv.put('settings:pricing_mode', 'full');
  assert((await getPricingMode(kv)) === 'full', 'getPricingMode should read back "full" once set');

  await kv.put('settings:pricing_mode', 'something-unexpected');
  assert((await getPricingMode(kv)) === 'founding', 'any value other than "full" should fall back to founding');

  console.log('PASS: kv.test.js');
}

await main();
