// expense-intake/src/twilio.js

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function parseFormBody(text) {
  return Object.fromEntries(new URLSearchParams(text));
}

// Twilio's request-signing algorithm: HMAC-SHA1(authToken, url + sortedKey1 + value1 + sortedKey2 + value2 + ...),
// base64-encoded. https://www.twilio.com/docs/usage/webhooks/webhooks-security
export async function verifyTwilioSignature({ url, params, signature, authToken }) {
  if (!signature || !authToken) return false;

  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stringToSign));
  const expected = bufferToBase64(signed);

  return timingSafeEqual(expected, signature);
}

// Twilio's practical MMS limit is well under 10 media items per message. The cap below is
// defense-in-depth against a malformed/oversized NumMedia value (e.g. from an unverified or
// tampered request) driving the loop below into millions of iterations, not a limit Twilio
// itself would ever hit.
const MAX_MEDIA_ITEMS = 10;

export function extractWebhookFields(params) {
  const numMedia = Math.min(Number.parseInt(params.NumMedia || '0', 10) || 0, MAX_MEDIA_ITEMS);
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = params[`MediaUrl${i}`];
    if (mediaUrl) {
      media.push({ url: mediaUrl, contentType: params[`MediaContentType${i}`] || 'application/octet-stream' });
    }
  }
  return { from: params.From || '', to: params.To || '', body: params.Body || '', media, messageSid: params.MessageSid || '' };
}
