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

// Twilio's outbound REST API — the first outbound-send capability this Worker has needed;
// every reply built in earlier Build Order steps has been a synchronous TwiML response to
// an inbound webhook, which a Cron Trigger has no inbound request to piggyback on. An
// optional mediaUrl turns the send into an MMS (Step 8's vCard delivery) — Twilio's Messages
// API treats SMS/MMS through the same endpoint, MediaUrl is just an optional form field.
export async function sendSms({ accountSid, authToken, from, to, body, mediaUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = { To: to, From: from, Body: body };
  if (mediaUrl) {
    params.MediaUrl = mediaUrl;
  }
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.message) || `Twilio send failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}
