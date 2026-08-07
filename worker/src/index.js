// worker/src/index.js
import { loadCounties } from './counties.js';
import { handleAvailability, handleCheckout, handleWebhook, handlePortalLink } from './handlers.js';

const counties = loadCounties();

function isAllowedOrigin(origin, siteOrigin) {
  if (!origin) return false;
  if (origin === siteOrigin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin, siteOrigin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (isAllowedOrigin(origin, siteOrigin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function jsonResponse(result, origin, siteOrigin) {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, siteOrigin),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const siteOrigin = env.SITE_ORIGIN;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, siteOrigin) });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/availability/')) {
      const countyId = decodeURIComponent(url.pathname.slice('/availability/'.length));
      const result = await handleAvailability({ kv: env.COUNTY_LOCKS, counties, countyId });
      return jsonResponse(result, origin, siteOrigin);
    }

    if (request.method === 'POST' && url.pathname === '/checkout') {
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return jsonResponse({ status: 400, body: { error: 'invalid JSON body' } }, origin, siteOrigin);
      }
      const result = await handleCheckout({
        kv: env.COUNTY_LOCKS,
        counties,
        countyId: body.countyId,
        secretKey: env.STRIPE_SECRET_KEY,
        priceRecurringId: env.PRICE_RECURRING_ID,
        priceOnetimeId: env.PRICE_ONETIME_ID,
        successUrl: `${siteOrigin}/purchase-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${siteOrigin}/purchase.html`,
      });
      return jsonResponse(result, origin, siteOrigin);
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      const payload = await request.text();
      const sigHeader = request.headers.get('Stripe-Signature') || '';
      const result = await handleWebhook({
        kv: env.COUNTY_LOCKS,
        payload,
        sigHeader,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      });
      return jsonResponse(result, origin, siteOrigin);
    }

    if (request.method === 'GET' && url.pathname === '/portal-link') {
      const sessionId = url.searchParams.get('session_id');
      const result = await handlePortalLink({
        sessionId,
        secretKey: env.STRIPE_SECRET_KEY,
        returnUrl: `${siteOrigin}/purchase-success.html?session_id=${sessionId}`,
      });
      return jsonResponse(result, origin, siteOrigin);
    }

    return jsonResponse({ status: 404, body: { error: 'not found' } }, origin, siteOrigin);
  },
};
