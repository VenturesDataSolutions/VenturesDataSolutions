// worker/test/webhook.test.js
import crypto from 'node:crypto';
import { verifyStripeSignature } from '../src/webhook.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

// Independently computes a Stripe-style signature header using Node's built-in
// node:crypto, deliberately not reusing the Web-Crypto code path under test.
function stripeStyleHeader(secret, timestamp, payload) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

async function main() {
  const secret = 'whsec_test_123';
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const now = Math.floor(Date.now() / 1000);

  const validHeader = stripeStyleHeader(secret, now, payload);
  assert((await verifyStripeSignature(payload, validHeader, secret)) === true, 'a correctly signed, fresh payload should verify');

  const tamperedPayload = payload.replace('cs_1', 'cs_evil');
  assert((await verifyStripeSignature(tamperedPayload, validHeader, secret)) === false, 'a tampered payload must fail verification');

  const wrongSecretHeader = stripeStyleHeader('whsec_wrong', now, payload);
  assert((await verifyStripeSignature(payload, wrongSecretHeader, secret)) === false, 'a signature made with the wrong secret must fail');

  const staleHeader = stripeStyleHeader(secret, now - 1000, payload);
  assert((await verifyStripeSignature(payload, staleHeader, secret)) === false, 'a signature older than the tolerance window must fail');

  assert((await verifyStripeSignature(payload, '', secret)) === false, 'a missing signature header must fail');
  assert((await verifyStripeSignature(payload, 'garbage', secret)) === false, 'a malformed signature header must fail');

  // Stripe sends multiple v1 signatures during webhook secret rotation; any one matching is enough.
  const correctV1 = crypto.createHmac('sha256', secret).update(`${now}.${payload}`).digest('hex');
  const wrongV1 = crypto.createHmac('sha256', 'whsec_wrong').update(`${now}.${payload}`).digest('hex');
  assert((await verifyStripeSignature(payload, `t=${now},v1=${wrongV1},v1=${correctV1}`, secret)) === true, 'a header with multiple v1 signatures should verify if any one of them matches');
  assert((await verifyStripeSignature(payload, `t=${now},v1=${wrongV1}`, secret)) === false, 'a header whose only v1 signature is wrong must still fail');

  // A non-numeric but correctly-signed timestamp should fail closed via the Number.isNaN(age)
  // branch specifically (not the signature check), and must not throw.
  const nonNumericTimestamp = 'not-a-number';
  const nonNumericSig = crypto.createHmac('sha256', secret).update(`${nonNumericTimestamp}.${payload}`).digest('hex');
  assert((await verifyStripeSignature(payload, `t=${nonNumericTimestamp},v1=${nonNumericSig}`, secret)) === false, 'a non-numeric timestamp must fail verification without throwing');

  console.log('PASS: webhook.test.js');
}

await main();
