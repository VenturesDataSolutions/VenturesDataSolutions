// expense-intake/src/gmail-client.js
import { encode as base64UrlEncode, decodeToBytes as base64UrlDecodeToBytes } from './base64url.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Header values here can originate from an attacker-controlled inbound email (gmail-poll.js
// builds reply subjects from the parsed inbound subject). Strip any embedded CR/LF so a
// crafted subject/header value can't fold in a bogus extra header line (e.g. a smuggled
// "Bcc:") into the outbound RFC 2822 message. Folding to a space (not throwing) matches this
// codebase's practice of never letting adversarial email content raise on this path.
function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
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
  const headerLines = [
    `To: ${sanitizeHeaderValue(to)}`,
    `From: ${sanitizeHeaderValue(from)}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  for (const [name, value] of Object.entries(headers)) {
    headerLines.push(`${sanitizeHeaderValue(name)}: ${sanitizeHeaderValue(value)}`);
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
