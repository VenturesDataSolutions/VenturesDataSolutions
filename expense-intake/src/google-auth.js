// expense-intake/src/google-auth.js
import { encode as base64UrlEncode } from './base64url.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(claimSet, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncodeString(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const encodedSignature = base64UrlEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}

export async function getGoogleAccessToken({ serviceAccountJson, fetchImpl, now }) {
  const account = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const getNow = now || Date.now;
  const nowSeconds = Math.floor(getNow() / 1000);
  const claimSet = {
    iss: account.client_email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const jwt = await signJwt(claimSet, account.private_key);

  const doFetch = fetchImpl || fetch;
  const response = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error_description) || (data && data.error) || `Google token request failed with status ${response.status}`;
    throw new Error(message);
  }
  if (!data || typeof data.access_token !== 'string') {
    throw new Error('Google token response missing access_token');
  }
  return data.access_token;
}
