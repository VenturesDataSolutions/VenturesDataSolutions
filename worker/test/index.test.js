// worker/test/index.test.js
import crypto from 'node:crypto';
import workerModule from '../src/index.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function baseEnv(kv) {
  return {
    COUNTY_LOCKS: kv,
    SITE_ORIGIN: 'https://venturesdatasolutions.com',
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    PRICE_RECURRING_ID: 'price_r',
    PRICE_ONETIME_ID: 'price_o',
  };
}

async function main() {
  // GET /availability/:countyId with an allowed origin sets CORS headers
  let kv = createFakeKV();
  let request = new Request('https://api.venturesdatasolutions.com/availability/01001', {
    method: 'GET',
    headers: { Origin: 'https://venturesdatasolutions.com' },
  });
  let response = await workerModule.fetch(request, baseEnv(kv));
  assert(response.status === 200, 'availability for a known county should 200');
  let body = await response.json();
  assert(body.available === true, 'a fresh county should be available');
  assert(response.headers.get('Access-Control-Allow-Origin') === 'https://venturesdatasolutions.com', 'CORS header should echo the allowed site origin');

  // localhost dev origin is allowed too
  request = new Request('https://api.venturesdatasolutions.com/availability/01001', {
    method: 'GET',
    headers: { Origin: 'http://localhost:8080' },
  });
  response = await workerModule.fetch(request, baseEnv(createFakeKV()));
  assert(response.headers.get('Access-Control-Allow-Origin') === 'http://localhost:8080', 'localhost origins should be allowed for local dev');

  // a disallowed origin gets no CORS allow header
  request = new Request('https://api.venturesdatasolutions.com/availability/01001', {
    method: 'GET',
    headers: { Origin: 'https://evil.example.com' },
  });
  response = await workerModule.fetch(request, baseEnv(createFakeKV()));
  assert(!response.headers.get('Access-Control-Allow-Origin'), 'a disallowed origin should not receive a CORS allow header');

  // unknown route 404s
  request = new Request('https://api.venturesdatasolutions.com/nope', { method: 'GET' });
  response = await workerModule.fetch(request, baseEnv(createFakeKV()));
  assert(response.status === 404, 'an unknown route should 404');

  // OPTIONS preflight
  request = new Request('https://api.venturesdatasolutions.com/checkout', {
    method: 'OPTIONS',
    headers: { Origin: 'https://venturesdatasolutions.com' },
  });
  response = await workerModule.fetch(request, baseEnv(createFakeKV()));
  assert(response.status === 204, 'an OPTIONS preflight should return 204');

  // POST /checkout happy path — stub global fetch so no real network call happens
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }) });
  try {
    request = new Request('https://api.venturesdatasolutions.com/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://venturesdatasolutions.com' },
      body: JSON.stringify({ countyId: '01001' }),
    });
    response = await workerModule.fetch(request, baseEnv(createFakeKV()));
    body = await response.json();
    assert(response.status === 200 && body.url === 'https://checkout.stripe.com/pay/cs_1', '/checkout should return the Stripe Checkout URL');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // POST /webhook with a valid signature locks the county through the real route
  const webhookKv = createFakeKV();
  const secret = 'whsec_test';
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { countyId: '01001' } } },
  });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  request = new Request('https://api.venturesdatasolutions.com/webhook', {
    method: 'POST',
    headers: { 'Stripe-Signature': `t=${ts},v1=${v1}` },
    body: payload,
  });
  response = await workerModule.fetch(request, baseEnv(webhookKv));
  assert(response.status === 200, 'a validly signed webhook should return 200');
  const lock = await webhookKv.get('01001', { type: 'json' });
  assert(lock && lock.customerId === 'cus_1', 'the webhook route should write the county lock');

  console.log('PASS: index.test.js');
}

await main();
