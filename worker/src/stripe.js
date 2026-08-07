// worker/src/stripe.js
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function toFormParams(value, prefix, out) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => toFormParams(item, `${prefix}[${index}]`, out));
  } else if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const nextPrefix = prefix ? `${prefix}[${key}]` : key;
      toFormParams(value[key], nextPrefix, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

export function toFormBody(params) {
  return toFormParams(params, '', []).join('&');
}

export async function stripeRequest({ secretKey, method, path, params, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${STRIPE_API_BASE}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
    },
  };
  if (method === 'POST' && params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = toFormBody(params);
  }
  const response = await doFetch(url, init);
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error && data.error.message) || `Stripe request failed with status ${response.status}`;
    const error = new Error(message);
    error.stripeStatus = response.status;
    throw error;
  }
  return data;
}

export async function createCheckoutSession({ secretKey, countyId, pricingMode, priceRecurringId, priceOnetimeId, successUrl, cancelUrl, fetchImpl }) {
  const lineItems = [{ price: priceRecurringId, quantity: 1 }];
  if (pricingMode === 'full') {
    lineItems.push({ price: priceOnetimeId, quantity: 1 });
  }
  const params = {
    mode: 'subscription',
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Session-level metadata (read by the checkout.session.completed webhook)
    metadata: { countyId },
    // Subscription-level metadata (read by the customer.subscription.deleted webhook)
    subscription_data: { metadata: { countyId } },
    custom_text: {
      submit: { message: "If we're unable to service your county, you'll be refunded in full within 1-7 business days." },
    },
  };
  return stripeRequest({ secretKey, method: 'POST', path: '/checkout/sessions', params, fetchImpl });
}

export async function retrieveCheckoutSession({ secretKey, sessionId, fetchImpl }) {
  return stripeRequest({ secretKey, method: 'GET', path: `/checkout/sessions/${encodeURIComponent(sessionId)}`, fetchImpl });
}

export async function createPortalSession({ secretKey, customerId, returnUrl, fetchImpl }) {
  return stripeRequest({
    secretKey,
    method: 'POST',
    path: '/billing_portal/sessions',
    params: { customer: customerId, return_url: returnUrl },
    fetchImpl,
  });
}
