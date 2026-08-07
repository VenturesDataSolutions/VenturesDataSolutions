// worker/src/handlers.js
import { isValidCountyId } from './counties.js';
import { getCountyLock, setCountyLock, clearCountyLock, getPricingMode } from './kv.js';
import { createCheckoutSession, retrieveCheckoutSession, createPortalSession } from './stripe.js';
import { verifyStripeSignature } from './webhook.js';

export async function handleAvailability({ kv, counties, countyId }) {
  if (!countyId || !isValidCountyId(counties, countyId)) {
    return { status: 404, body: { error: 'unknown county' } };
  }
  const lock = await getCountyLock(kv, countyId);
  return { status: 200, body: { available: !lock } };
}

export async function handleCheckout({ kv, counties, countyId, secretKey, priceRecurringId, priceOnetimeId, successUrl, cancelUrl, fetchImpl }) {
  if (!countyId || !isValidCountyId(counties, countyId)) {
    return { status: 400, body: { error: 'invalid county' } };
  }
  const existingLock = await getCountyLock(kv, countyId);
  if (existingLock) {
    return { status: 409, body: { error: 'county already claimed' } };
  }
  const pricingMode = await getPricingMode(kv);
  try {
    const session = await createCheckoutSession({
      secretKey, countyId, pricingMode, priceRecurringId, priceOnetimeId, successUrl, cancelUrl, fetchImpl,
    });
    return { status: 200, body: { url: session.url } };
  } catch (err) {
    return { status: 502, body: { error: err.message } };
  }
}

export async function handleWebhook({ kv, payload, sigHeader, webhookSecret }) {
  const valid = await verifyStripeSignature(payload, sigHeader, webhookSecret);
  if (!valid) {
    return { status: 400, body: { error: 'invalid signature' } };
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch (err) {
    return { status: 400, body: { error: 'invalid JSON payload' } };
  }

  if (!event || !event.data || !event.data.object) {
    return { status: 400, body: { error: 'malformed event payload' } };
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const countyId = session.metadata && session.metadata.countyId;
    if (countyId) {
      await setCountyLock(kv, countyId, {
        customerId: session.customer,
        subscriptionId: session.subscription,
        claimedAt: new Date().toISOString(),
      });
    } else {
      // A completed, paid checkout with no countyId means the county never gets locked —
      // surface this loudly rather than silently dropping it (visible in wrangler tail / Cloudflare logs).
      console.error('checkout.session.completed missing metadata.countyId', { sessionId: session.id });
    }
    return { status: 200, body: { received: true } };
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const countyId = subscription.metadata && subscription.metadata.countyId;
    if (countyId) {
      await clearCountyLock(kv, countyId);
    } else {
      console.error('customer.subscription.deleted missing metadata.countyId', { subscriptionId: subscription.id });
    }
    return { status: 200, body: { received: true } };
  }

  // Any other event type: acknowledge so Stripe doesn't retry it.
  return { status: 200, body: { received: true } };
}

export async function handlePortalLink({ sessionId, secretKey, returnUrl, fetchImpl }) {
  if (!sessionId) {
    return { status: 400, body: { error: 'session_id is required' } };
  }
  let session;
  try {
    session = await retrieveCheckoutSession({ secretKey, sessionId, fetchImpl });
  } catch (err) {
    if (err.stripeStatus === 404) {
      return { status: 404, body: { error: 'checkout session not found' } };
    }
    return { status: 502, body: { error: err.message } };
  }
  if (!session.customer) {
    return { status: 400, body: { error: 'checkout session has no associated customer' } };
  }
  try {
    const portal = await createPortalSession({ secretKey, customerId: session.customer, returnUrl, fetchImpl });
    return { status: 200, body: { url: portal.url } };
  } catch (err) {
    return { status: 502, body: { error: err.message } };
  }
}
