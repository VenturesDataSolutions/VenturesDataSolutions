// expense-intake/src/gmail-client.js
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function base64UrlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gmailErrorMessage(response) {
  const data = await response.json().catch(() => ({}));
  return (data && data.error && data.error.message) || `Gmail API call failed with status ${response.status}`;
}

export async function listUnreadMessageIds({ accessToken, maxResults, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${GMAIL_BASE}/messages?q=${encodeURIComponent('is:unread')}&maxResults=${maxResults}`;
  const response = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await gmailErrorMessage(response));
  const data = await response.json();
  return (data.messages || []).map((m) => m.id);
}

export async function getRawMessage({ accessToken, messageId, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${GMAIL_BASE}/messages/${messageId}?format=raw`;
  const response = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await gmailErrorMessage(response));
  const data = await response.json();
  return base64UrlDecodeToBytes(data.raw).buffer;
}

export async function markMessageRead({ accessToken, messageId, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const url = `${GMAIL_BASE}/messages/${messageId}/modify`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
  if (!response.ok) throw new Error(await gmailErrorMessage(response));
}

export function buildRawEmail({ to, from, subject, text, headers = {} }) {
  const headerLines = [`To: ${to}`, `From: ${from}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"'];
  for (const [name, value] of Object.entries(headers)) {
    headerLines.push(`${name}: ${value}`);
  }
  const message = `${headerLines.join('\r\n')}\r\n\r\n${text}`;
  return base64UrlEncode(new TextEncoder().encode(message));
}

export async function sendGmailMessage({ accessToken, to, from, subject, text, headers, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const raw = buildRawEmail({ to, from, subject, text, headers });
  const url = `${GMAIL_BASE}/messages/send`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!response.ok) throw new Error(await gmailErrorMessage(response));
  const data = await response.json();
  return data.id;
}
