// worker/test/stripe.test.js
import { toFormBody, stripeRequest, createCheckoutSession, retrieveCheckoutSession, createPortalSession } from '../src/stripe.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(responseBody, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // toFormBody: Stripe bracket notation for nested arrays/objects
  const body = toFormBody({ mode: 'subscription', line_items: [{ price: 'price_a', quantity: 1 }] });
  assert(body.includes('mode=subscription'), 'toFormBody should encode top-level keys');
  assert(body.includes('line_items%5B0%5D%5Bprice%5D=price_a'), 'toFormBody should encode array/object nesting with bracket notation');

  // stripeRequest happy path
  const fetchImpl = fakeFetch({ id: 'cs_123', url: 'https://checkout.stripe.com/pay/cs_123' });
  const result = await stripeRequest({ secretKey: 'sk_test_x', method: 'POST', path: '/checkout/sessions', params: { mode: 'subscription' }, fetchImpl });
  assert(result.id === 'cs_123', 'stripeRequest should return the parsed JSON body');
  assert(fetchImpl.calls[0].url === 'https://api.stripe.com/v1/checkout/sessions', 'stripeRequest should hit the correct Stripe REST path');
  assert(fetchImpl.calls[0].init.headers.Authorization === 'Bearer sk_test_x', 'stripeRequest should send the secret key as a Bearer token');

  // stripeRequest error path
  const failFetch = fakeFetch({ error: { message: 'No such price' } }, 402);
  let threw = false;
  try {
    await stripeRequest({ secretKey: 'sk_test_x', method: 'POST', path: '/checkout/sessions', params: {}, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'No such price', 'stripeRequest should surface the Stripe error message');
  }
  assert(threw, 'stripeRequest should throw on a non-2xx Stripe response');

  // createCheckoutSession: founding mode omits the one-time line item
  const foundingFetch = fakeFetch({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' });
  await createCheckoutSession({
    secretKey: 'sk_test_x', countyId: '01001', pricingMode: 'founding',
    priceRecurringId: 'price_r', priceOnetimeId: 'price_o',
    successUrl: 'https://x/success', cancelUrl: 'https://x/cancel', fetchImpl: foundingFetch,
  });
  const foundingBody = foundingFetch.calls[0].init.body;
  assert(foundingBody.includes('line_items%5B0%5D%5Bprice%5D=price_r'), 'founding mode should include the recurring price as the first line item');
  assert(!foundingBody.includes('price_o'), 'founding mode should not include the one-time price');
  assert(foundingBody.includes('metadata%5BcountyId%5D=01001'), 'session metadata should carry countyId (for checkout.session.completed)');
  assert(foundingBody.includes('subscription_data%5Bmetadata%5D%5BcountyId%5D=01001'), 'subscription metadata should carry countyId (for customer.subscription.deleted)');
  assert(foundingBody.includes('custom_text%5Bsubmit%5D%5Bmessage%5D='), 'checkout session should set the refund disclaimer as Stripe custom_text');

  // createCheckoutSession: full mode includes both line items
  const fullFetch = fakeFetch({ id: 'cs_2', url: 'https://checkout.stripe.com/pay/cs_2' });
  await createCheckoutSession({
    secretKey: 'sk_test_x', countyId: '01001', pricingMode: 'full',
    priceRecurringId: 'price_r', priceOnetimeId: 'price_o',
    successUrl: 'https://x/success', cancelUrl: 'https://x/cancel', fetchImpl: fullFetch,
  });
  const fullBody = fullFetch.calls[0].init.body;
  assert(fullBody.includes('price_r') && fullBody.includes('price_o'), 'full mode should include both the recurring and one-time price');

  // retrieveCheckoutSession
  const retrieveFetch = fakeFetch({ id: 'cs_3', customer: 'cus_3' });
  const session = await retrieveCheckoutSession({ secretKey: 'sk_test_x', sessionId: 'cs_3', fetchImpl: retrieveFetch });
  assert(session.customer === 'cus_3', 'retrieveCheckoutSession should return the session');
  assert(retrieveFetch.calls[0].url === 'https://api.stripe.com/v1/checkout/sessions/cs_3', 'retrieveCheckoutSession should GET the correct path');

  // createPortalSession
  const portalFetch = fakeFetch({ url: 'https://billing.stripe.com/session/abc' });
  const portal = await createPortalSession({ secretKey: 'sk_test_x', customerId: 'cus_3', returnUrl: 'https://x/return', fetchImpl: portalFetch });
  assert(portal.url === 'https://billing.stripe.com/session/abc', 'createPortalSession should return the portal url');
  assert(portalFetch.calls[0].init.body.includes('customer=cus_3'), 'createPortalSession should send the customer id');

  console.log('PASS: stripe.test.js');
}

await main();
