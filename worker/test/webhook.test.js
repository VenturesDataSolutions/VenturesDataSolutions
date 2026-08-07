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

  console.log('PASS: webhook.test.js');
}

await main();
