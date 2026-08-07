// worker/src/webhook.js
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function computeSignature(secret, timestamp, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return bufferToHex(signed);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyStripeSignature(payload, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader) return false;

  let timestamp;
  const v1Signatures = [];
  for (const part of sigHeader.split(',')) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) v1Signatures.push(value);
  }
  if (!timestamp || v1Signatures.length === 0) return false;

  // Stripe sends multiple v1 signatures during webhook secret rotation;
  // any one of them matching is sufficient.
  const expected = await computeSignature(secret, timestamp, payload);
  const matches = v1Signatures.some((v1) => timingSafeEqual(expected, v1));
  if (!matches) return false;

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (Number.isNaN(age) || age > toleranceSeconds) return false;

  return true;
}
