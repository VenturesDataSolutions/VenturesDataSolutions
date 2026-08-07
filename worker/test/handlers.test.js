// worker/test/handlers.test.js
import crypto from 'node:crypto';
import { handleAvailability, handleCheckout, handleWebhook, handlePortalLink } from '../src/handlers.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

const counties = [{ id: '01001', name: 'Autauga County', state: 'AL' }];

function fakeFetch(responseBody, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => responseBody });
}

async function main() {
  // availability: unknown county
  let result = await handleAvailability({ kv: createFakeKV(), counties, countyId: '99999' });
  assert(result.status === 404, 'unknown county should 404');

  // availability: fresh county is available
  result = await handleAvailability({ kv: createFakeKV(), counties, countyId: '01001' });
  assert(result.status === 200 && result.body.available === true, 'fresh county should be available');

  // availability: claimed county is unavailable
  const claimedKv = createFakeKV({ '01001': JSON.stringify({ customerId: 'cus_1', subscriptionId: 'sub_1', claimedAt: 'x' }) });
  result = await handleAvailability({ kv: claimedKv, counties, countyId: '01001' });
  assert(result.status === 200 && result.body.available === false, 'claimed county should be unavailable');

  // checkout: invalid county
  result = await handleCheckout({ kv: createFakeKV(), counties, countyId: '99999', secretKey: 'sk', priceRecurringId: 'price_r', priceOnetimeId: 'price_o', successUrl: 'https://x/s', cancelUrl: 'https://x/c', fetchImpl: fakeFetch({}) });
  assert(result.status === 400, 'checkout should reject an invalid county');

  // checkout: already claimed
  result = await handleCheckout({ kv: claimedKv, counties, countyId: '01001', secretKey: 'sk', priceRecurringId: 'price_r', priceOnetimeId: 'price_o', successUrl: 'https://x/s', cancelUrl: 'https://x/c', fetchImpl: fakeFetch({}) });
  assert(result.status === 409, 'checkout should reject a county that is already claimed (the race-condition guard)');

  // checkout: happy path
  result = await handleCheckout({ kv: createFakeKV(), counties, countyId: '01001', secretKey: 'sk', priceRecurringId: 'price_r', priceOnetimeId: 'price_o', successUrl: 'https://x/s', cancelUrl: 'https://x/c', fetchImpl: fakeFetch({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }) });
  assert(result.status === 200 && result.body.url === 'https://checkout.stripe.com/pay/cs_1', 'checkout should return the Stripe Checkout URL');

  // checkout: a Stripe-side error surfaces as 502
  result = await handleCheckout({ kv: createFakeKV(), counties, countyId: '01001', secretKey: 'sk', priceRecurringId: 'price_r', priceOnetimeId: 'price_o', successUrl: 'https://x/s', cancelUrl: 'https://x/c', fetchImpl: fakeFetch({ error: { message: 'No such price' } }, 402) });
  assert(result.status === 502 && result.body.error === 'No such price', 'a Stripe error should surface as a 502 with the Stripe message');

  // webhook: checkout.session.completed locks the county
  const webhookKv = createFakeKV();
  const secret = 'whsec_test';
  function sign(payload, timestamp) {
    const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return `t=${timestamp},v1=${v1}`;
  }
  const completedPayload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { countyId: '01001' } } },
  });
  result = await handleWebhook({ kv: webhookKv, payload: completedPayload, sigHeader: sign(completedPayload, Math.floor(Date.now() / 1000)), webhookSecret: secret });
  assert(result.status === 200, 'a valid webhook should return 200');
  let lockAfter = await webhookKv.get('01001', { type: 'json' });
  assert(lockAfter && lockAfter.customerId === 'cus_1', 'checkout.session.completed should write the county lock');

  // webhook: bad signature is rejected
  result = await handleWebhook({ kv: webhookKv, payload: completedPayload, sigHeader: 'garbage', webhookSecret: secret });
  assert(result.status === 400, 'an invalid signature should be rejected');

  // webhook: customer.subscription.deleted clears the county
  const deletedPayload = JSON.stringify({
    type: 'customer.subscription.deleted',
    data: { object: { metadata: { countyId: '01001' } } },
  });
  result = await handleWebhook({ kv: webhookKv, payload: deletedPayload, sigHeader: sign(deletedPayload, Math.floor(Date.now() / 1000)), webhookSecret: secret });
  assert(result.status === 200, 'a valid deletion webhook should return 200');
  lockAfter = await webhookKv.get('01001', { type: 'json' });
  assert(lockAfter === null, 'customer.subscription.deleted should clear the county lock');

  // webhook: an unhandled event type is acknowledged, not errored
  const otherPayload = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
  result = await handleWebhook({ kv: webhookKv, payload: otherPayload, sigHeader: sign(otherPayload, Math.floor(Date.now() / 1000)), webhookSecret: secret });
  assert(result.status === 200, 'an unhandled but validly-signed event type should still 200 (so Stripe does not retry it)');

  // webhook: a validly-signed but malformed payload (missing data.object) must fail gracefully, not throw
  const malformedPayload = JSON.stringify({ type: 'checkout.session.completed' });
  result = await handleWebhook({ kv: webhookKv, payload: malformedPayload, sigHeader: sign(malformedPayload, Math.floor(Date.now() / 1000)), webhookSecret: secret });
  assert(result.status === 400, 'a validly-signed event missing data.object should return 400, not throw');

  // portal-link: missing session id
  result = await handlePortalLink({ sessionId: null, secretKey: 'sk', returnUrl: 'https://x/r', fetchImpl: fakeFetch({}) });
  assert(result.status === 400, 'portal-link should require a session_id');

  // portal-link: happy path (looks up the session, then creates a portal session)
  let callCount = 0;
  const portalFetch = async (url) => {
    callCount += 1;
    if (url.includes('/checkout/sessions/')) {
      return { ok: true, status: 200, json: async () => ({ id: 'cs_1', customer: 'cus_1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ url: 'https://billing.stripe.com/session/abc' }) };
  };
  result = await handlePortalLink({ sessionId: 'cs_1', secretKey: 'sk', returnUrl: 'https://x/r', fetchImpl: portalFetch });
  assert(result.status === 200 && result.body.url === 'https://billing.stripe.com/session/abc', 'portal-link should return the portal URL');
  assert(callCount === 2, 'portal-link should make exactly two Stripe calls: retrieve session, then create portal session');

  // portal-link: session with no customer
  const noCustomerFetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'cs_2', customer: null }) });
  result = await handlePortalLink({ sessionId: 'cs_2', secretKey: 'sk', returnUrl: 'https://x/r', fetchImpl: noCustomerFetch });
  assert(result.status === 400, 'portal-link should reject a session with no associated customer');

  // portal-link: Stripe genuinely has no such session (404) should surface as 404
  result = await handlePortalLink({ sessionId: 'cs_missing', secretKey: 'sk', returnUrl: 'https://x/r', fetchImpl: fakeFetch({ error: { message: 'No such checkout session' } }, 404) });
  assert(result.status === 404, 'a real Stripe 404 on session lookup should surface as 404');

  // portal-link: any other Stripe failure (e.g. an outage) must not be conflated with "not found"
  result = await handlePortalLink({ sessionId: 'cs_3', secretKey: 'sk', returnUrl: 'https://x/r', fetchImpl: fakeFetch({ error: { message: 'Internal Stripe error' } }, 500) });
  assert(result.status === 502 && result.body.error === 'Internal Stripe error', 'a non-404 Stripe failure on session lookup should surface as 502, not be misreported as 404');

  console.log('PASS: handlers.test.js');
}

await main();
