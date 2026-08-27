# Expense Intake — Gmail API Transport Swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cloudflare Email Routing (inbound) and Cloudflare Email Sending (outbound) in the `expense-intake` Worker with Gmail API integration authenticated as `venturesdatasolutions@gmail.com`, while keeping every transport-agnostic part of the existing email-intake pipeline (sender resolution, MIME parsing, photo storage, expense filing, reply composition) unchanged.

**Architecture:** A new 2-minute Cron Trigger polls `users.messages.list?q=is:unread`, fetches each message's raw MIME via `users.messages.get?format=raw`, feeds it through the existing `postal-mime`-based parser, and files/replies exactly as the old `email()` handler did — replying via `users.messages.send` and clearing the `UNREAD` label via `users.messages.modify` when done. OAuth access tokens are obtained via refresh-token exchange and cached in the existing `CONVERSATION_STATE` KV namespace. The Cloudflare `email()` export and `send_email` binding are removed entirely.

**Tech Stack:** Cloudflare Workers, D1, KV, R2, Images binding, `postal-mime` (unchanged), hand-rolled Gmail REST client (no new npm dependency — matches this codebase's existing pattern for Sheets/Twilio, both hand-rolled `fetch` wrappers).

**Reference:** [`docs/superpowers/specs/2026-08-26-expense-intake-gmail-transport-design.md`](../specs/2026-08-26-expense-intake-gmail-transport-design.md)

---

### Task 1: Extend `parseInboundEmail` to expose sender address and Auto-Submitted header

The Cloudflare `email()` handler got the sender address from `message.from` (a field Cloudflare provided separately from the raw MIME) and the `Auto-Submitted` header from `message.headers` (also separate from the raw MIME body). Gmail's `messages.get?format=raw` gives back *only* raw MIME bytes — no separate envelope metadata — so both of those need to come from parsing the MIME itself now.

**Files:**
- Modify: `expense-intake/src/email-intake.js`
- Test: `expense-intake/test/email-intake.test.js`

- [ ] **Step 1: Write the failing test**

Add to `expense-intake/test/email-intake.test.js`, inside `main()`, right after the existing "parseInboundEmail: no attachment, no Message-ID" block (before the final `console.log`):

```js
  // parseInboundEmail: extracts the sender address from the From header
  {
    const raw = buildRawMime({
      from: 'Owner <owner@acme.com>', to: 'venturesdatasolutions@gmail.com',
      subject: 'Receipt', messageId: '<from-test@acme.com>', textBody: 'hi',
    });
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.from === 'owner@acme.com', 'must extract the bare address from a "Display Name <addr>" From header');
  }

  // parseInboundEmail: extracts the Auto-Submitted header when present
  {
    const boundary = 'BOUNDARY123';
    const raw = [
      'From: owner@acme.com', 'To: venturesdatasolutions@gmail.com', 'Subject: Out of office',
      'Auto-Submitted: auto-replied',
      `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', 'I am out of office.', '',
      `--${boundary}--`, '',
    ].join('\r\n');
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.autoSubmitted === 'auto-replied', 'must extract the Auto-Submitted header value when present');
  }

  // parseInboundEmail: autoSubmitted is null when the header is absent
  {
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'venturesdatasolutions@gmail.com',
      subject: 'Receipt', messageId: '<no-auto@acme.com>', textBody: 'hi',
    });
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.autoSubmitted === null, 'autoSubmitted must be null when the header is absent, not undefined');
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd expense-intake && node test/email-intake.test.js`
Expected: FAIL — `parsed.from` and `parsed.autoSubmitted` are `undefined`, assertions throw `ASSERTION FAILED`.

- [ ] **Step 3: Implement**

In `expense-intake/src/email-intake.js`, replace the `parseInboundEmail` function:

```js
export async function parseInboundEmail(rawArrayBuffer) {
  const parsed = await PostalMime.parse(rawArrayBuffer);
  const autoSubmittedHeader = (parsed.headers || []).find(
    (h) => h.key && h.key.toLowerCase() === 'auto-submitted'
  );
  return {
    subject: parsed.subject || '',
    text: parsed.text || '',
    messageId: parsed.messageId || null,
    attachments: parsed.attachments || [],
    from: (parsed.from && parsed.from.address) || '',
    autoSubmitted: autoSubmittedHeader ? autoSubmittedHeader.value : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd expense-intake && node test/email-intake.test.js`
Expected: `PASS: email-intake.test.js`

- [ ] **Step 5: Commit**

```bash
git add expense-intake/src/email-intake.js expense-intake/test/email-intake.test.js
git commit -m "Extend parseInboundEmail to expose sender address and Auto-Submitted header

Gmail's messages.get?format=raw returns only raw MIME bytes, unlike
Cloudflare's ForwardableEmailMessage which exposed .from/.headers
separately — both now need to come from parsing the MIME itself."
```

---

### Task 2: Gmail REST client (`gmail-client.js`)

Low-level, hand-rolled wrappers around the four Gmail API calls this Worker needs: list unread, get raw, mark read, send. Mirrors how `twilio.js`/`sheets.js` already wrap their respective REST APIs with plain `fetch`.

**Files:**
- Create: `expense-intake/src/gmail-client.js`
- Test: `expense-intake/test/gmail-client.test.js`

- [ ] **Step 1: Write the failing test**

Create `expense-intake/test/gmail-client.test.js`:

```js
// expense-intake/test/gmail-client.test.js
import { listUnreadMessageIds, getRawMessage, markMessageRead, sendGmailMessage, buildRawEmail } from '../src/gmail-client.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function main() {
  // buildRawEmail: builds a base64url-encoded RFC 2822 message with the given headers/body
  {
    const raw = buildRawEmail({
      to: 'owner@acme.com', from: 'venturesdatasolutions@gmail.com', subject: 'Re: Receipt',
      text: 'Logged: $42.50, Materials, Main St.',
      headers: { 'In-Reply-To': '<msg1@acme.com>', 'Auto-Submitted': 'auto-replied' },
    });
    const decoded = base64UrlDecode(raw).toString('utf8');
    assert(decoded.includes('To: owner@acme.com'), 'raw message must include the To header');
    assert(decoded.includes('From: venturesdatasolutions@gmail.com'), 'raw message must include the From header');
    assert(decoded.includes('Subject: Re: Receipt'), 'raw message must include the Subject header');
    assert(decoded.includes('In-Reply-To: <msg1@acme.com>'), 'raw message must include extra headers passed in');
    assert(decoded.includes('Auto-Submitted: auto-replied'), 'raw message must include the Auto-Submitted header');
    assert(decoded.endsWith('Logged: $42.50, Materials, Main St.'), 'raw message body must be the given text, after the header/body blank-line separator');
  }

  // listUnreadMessageIds: queries is:unread, returns just the ids
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages?', async (url) => {
        assert(url.includes('q=is%3Aunread'), 'must query is:unread');
        assert(url.includes('maxResults=25'), 'must pass through maxResults');
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }) };
      }],
    ]);
    const ids = await listUnreadMessageIds({ accessToken: 'ya29.tok', maxResults: 25, fetchImpl });
    assert(ids.length === 2 && ids[0] === 'm1' && ids[1] === 'm2', 'must return the message ids from the list response');
  }

  // listUnreadMessageIds: no unread messages -> empty array, not a crash on missing `messages` key
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages?', async () => ({ ok: true, status: 200, json: async () => ({}) })],
    ]);
    const ids = await listUnreadMessageIds({ accessToken: 'ya29.tok', maxResults: 25, fetchImpl });
    assert(Array.isArray(ids) && ids.length === 0, 'a response with no messages key must yield an empty array, not throw');
  }

  // listUnreadMessageIds: Gmail error response -> throws with the API's error message
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages?', async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials' } }) })],
    ]);
    let threw = false;
    try {
      await listUnreadMessageIds({ accessToken: 'bad', maxResults: 25, fetchImpl });
    } catch (err) {
      threw = true;
      assert(err.message === 'Invalid Credentials', "must surface Gmail's error.message");
    }
    assert(threw, 'a non-2xx list response must throw');
  }

  // getRawMessage: requests format=raw and decodes the base64url `raw` field back into the original bytes
  {
    const originalBytes = Buffer.from('From: a@b.com\r\nSubject: x\r\n\r\nbody', 'utf8');
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages/m1', async (url) => {
        assert(url.includes('format=raw'), 'must request format=raw');
        return { ok: true, status: 200, json: async () => ({ raw: base64UrlEncode(originalBytes) }) };
      }],
    ]);
    const rawBuffer = await getRawMessage({ accessToken: 'ya29.tok', messageId: 'm1', fetchImpl });
    assert(Buffer.from(rawBuffer).toString('utf8') === originalBytes.toString('utf8'), 'must decode the raw field back to the original MIME bytes');
  }

  // markMessageRead: removes the UNREAD label
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify', async (url, init) => {
        assert(init.method === 'POST', 'modify must be a POST');
        const body = JSON.parse(init.body);
        assert(Array.isArray(body.removeLabelIds) && body.removeLabelIds.includes('UNREAD'), 'must remove the UNREAD label');
        return { ok: true, status: 200, json: async () => ({ id: 'm1', labelIds: [] }) };
      }],
    ]);
    await markMessageRead({ accessToken: 'ya29.tok', messageId: 'm1', fetchImpl });
    assert(fetchImpl.calls.length === 1, 'must make exactly one modify call');
  }

  // markMessageRead: Gmail error response -> throws
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify', async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Requested entity was not found.' } }) })],
    ]);
    let threw = false;
    try {
      await markMessageRead({ accessToken: 'ya29.tok', messageId: 'm1', fetchImpl });
    } catch (err) {
      threw = true;
      assert(err.message === 'Requested entity was not found.', "must surface Gmail's error.message");
    }
    assert(threw, 'a non-2xx modify response must throw');
  }

  // sendGmailMessage: posts a base64url-encoded raw message, returns the new message id
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages/send', async (url, init) => {
        assert(init.method === 'POST', 'send must be a POST');
        const body = JSON.parse(init.body);
        const decoded = base64UrlDecode(body.raw).toString('utf8');
        assert(decoded.includes('To: owner@acme.com'), 'the encoded raw message must carry the To header');
        assert(decoded.includes('Logged: $42.50'), 'the encoded raw message must carry the body text');
        return { ok: true, status: 200, json: async () => ({ id: 'sent1' }) };
      }],
    ]);
    const id = await sendGmailMessage({
      accessToken: 'ya29.tok', to: 'owner@acme.com', from: 'venturesdatasolutions@gmail.com',
      subject: 'Re: Receipt', text: 'Logged: $42.50, Materials, Main St.', headers: {}, fetchImpl,
    });
    assert(id === 'sent1', 'must return the id of the sent message');
  }

  // sendGmailMessage: Gmail error response -> throws
  {
    const fetchImpl = fakeFetch([
      ['gmail.googleapis.com/gmail/v1/users/me/messages/send', async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Insufficient Permission' } }) })],
    ]);
    let threw = false;
    try {
      await sendGmailMessage({ accessToken: 'ya29.tok', to: 'x@y.com', from: 'venturesdatasolutions@gmail.com', subject: 'x', text: 'y', headers: {}, fetchImpl });
    } catch (err) {
      threw = true;
      assert(err.message === 'Insufficient Permission', "must surface Gmail's error.message");
    }
    assert(threw, 'a non-2xx send response must throw');
  }

  console.log('PASS: gmail-client.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd expense-intake && node test/gmail-client.test.js`
Expected: FAIL — `Cannot find module '../src/gmail-client.js'`

- [ ] **Step 3: Implement**

Create `expense-intake/src/gmail-client.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd expense-intake && node test/gmail-client.test.js`
Expected: `PASS: gmail-client.test.js`

- [ ] **Step 5: Add to the test runner**

In `expense-intake/test/run-all.js`, add `import './gmail-client.test.js';` right after `import './email-intake.test.js';`.

- [ ] **Step 6: Commit**

```bash
git add expense-intake/src/gmail-client.js expense-intake/test/gmail-client.test.js expense-intake/test/run-all.js
git commit -m "Add gmail-client.js: hand-rolled Gmail API wrappers for list/get/modify/send

Mirrors this codebase's existing pattern of hand-rolled fetch wrappers
for Twilio/Sheets rather than pulling in the Google API Node client,
which isn't Workers-compatible anyway."
```

---

### Task 3: OAuth token exchange with KV caching (`gmail-auth.js`)

**Files:**
- Create: `expense-intake/src/gmail-auth.js`
- Test: `expense-intake/test/gmail-auth.test.js`

- [ ] **Step 1: Write the failing test**

Create `expense-intake/test/gmail-auth.test.js`:

```js
// expense-intake/test/gmail-auth.test.js
import { getGmailAccessToken } from '../src/gmail-auth.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // cache hit: returns the cached token, makes no network call at all
  {
    const kv = createFakeKV({ gmail_access_token: 'ya29.cached' });
    const fetchImpl = fakeFetch(true, 200, {});
    const token = await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    assert(token === 'ya29.cached', 'a cached token must be returned as-is');
    assert(fetchImpl.calls.length === 0, 'a cache hit must not call the network at all');
  }

  // cache miss: exchanges the refresh token, caches the result with a safety-margined TTL
  {
    const kv = createFakeKV();
    const fetchImpl = fakeFetch(true, 200, { access_token: 'ya29.fresh', token_type: 'Bearer', expires_in: 3600 });
    const token = await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    assert(token === 'ya29.fresh', 'a cache miss must return the freshly exchanged access token');

    const call = fetchImpl.calls[0];
    assert(call.url === 'https://oauth2.googleapis.com/token', 'must POST to the Google token endpoint');
    const bodyParams = new URLSearchParams(call.init.body);
    assert(bodyParams.get('grant_type') === 'refresh_token', 'must use the refresh_token grant type');
    assert(bodyParams.get('client_id') === 'cid', 'must send the client id');
    assert(bodyParams.get('client_secret') === 'csec', 'must send the client secret');
    assert(bodyParams.get('refresh_token') === 'rtok', 'must send the refresh token');

    const putCall = kv.calls.find((c) => c.method === 'put');
    assert(putCall && putCall.key === 'gmail_access_token' && putCall.value === 'ya29.fresh', 'the fresh token must be cached under a fixed KV key');
    assert(putCall.options.expirationTtl === 3600 - 120, 'the cache TTL must be the token lifetime minus a safety margin, so a near-expiry token is never handed out');
  }

  // error path: Google rejects the refresh -> throws with the error_description
  {
    const kv = createFakeKV();
    const fetchImpl = fakeFetch(false, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    let threw = false;
    try {
      await getGmailAccessToken({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok', kv, fetchImpl });
    } catch (err) {
      threw = true;
      assert(err.message === 'Token has been expired or revoked.', "must surface Google's error_description");
    }
    assert(threw, 'a non-2xx token response must throw');
  }

  console.log('PASS: gmail-auth.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd expense-intake && node test/gmail-auth.test.js`
Expected: FAIL — `Cannot find module '../src/gmail-auth.js'`

- [ ] **Step 3: Implement**

Create `expense-intake/src/gmail-auth.js`:

```js
// expense-intake/src/gmail-auth.js
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN_KV_KEY = 'gmail_access_token';
const EXPIRY_SAFETY_MARGIN_SECONDS = 120;

export async function getGmailAccessToken({ clientId, clientSecret, refreshToken, kv, fetchImpl }) {
  const cached = await kv.get(ACCESS_TOKEN_KV_KEY);
  if (cached) return cached;

  const doFetch = fetchImpl || fetch;
  const response = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error_description) || (data && data.error) || `Gmail token refresh failed with status ${response.status}`;
    throw new Error(message);
  }
  if (!data || typeof data.access_token !== 'string') {
    throw new Error('Gmail token response missing access_token');
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  const ttl = Math.max(60, expiresIn - EXPIRY_SAFETY_MARGIN_SECONDS);
  await kv.put(ACCESS_TOKEN_KV_KEY, data.access_token, { expirationTtl: ttl });

  return data.access_token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd expense-intake && node test/gmail-auth.test.js`
Expected: `PASS: gmail-auth.test.js`

- [ ] **Step 5: Add to the test runner**

In `expense-intake/test/run-all.js`, add `import './gmail-auth.test.js';` right after `import './gmail-client.test.js';`.

- [ ] **Step 6: Commit**

```bash
git add expense-intake/src/gmail-auth.js expense-intake/test/gmail-auth.test.js expense-intake/test/run-all.js
git commit -m "Add gmail-auth.js: refresh-token exchange with KV-cached access tokens

Workers are stateless between invocations, so the access token can't be
cached in memory — it's cached in the existing CONVERSATION_STATE KV
namespace instead, with a 120s safety margin below its real expiry."
```

---

### Task 4: Gmail poll loop and per-message processing (`gmail-poll.js`)

This is the direct replacement for the old `handleEmailWebhook` in `handlers.js` — same sender resolution, photo storage, and expense-filing logic, adapted to Gmail's poll model instead of Cloudflare's push-per-message model.

**Files:**
- Create: `expense-intake/src/gmail-poll.js`
- Test: `expense-intake/test/gmail-poll.test.js`

- [ ] **Step 1: Write the failing test**

Create `expense-intake/test/gmail-poll.test.js`:

```js
// expense-intake/test/gmail-poll.test.js
import { processGmailMessage, pollGmailInbox } from '../src/gmail-poll.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dispatchFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonOk(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function openRouterRouter({ parse, match, copy }) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    let content = copy;
    if (typeof system === 'string' && system.includes('expense-parsing assistant')) content = parse;
    else if (typeof system === 'string' && system.includes('matching a text reply')) content = match;
    return { ok: true, status: 200, json: async () => chatResponse(content) };
  };
}

function buildRawMime({ from, to, subject, messageId, textBody, attachmentBase64 }) {
  const boundary = 'BOUNDARY123';
  const headerLines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`];
  if (messageId) headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [...headerLines, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody, ''];
  if (attachmentBase64) {
    parts.push(
      `--${boundary}`, 'Content-Type: image/jpeg; name="receipt.jpg"', 'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="receipt.jpg"', '', attachmentBase64, ''
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

function buildDeeplyNestedMime(depth) {
  let body = 'Content-Type: text/plain\r\n\r\nleaf content\r\n';
  for (let i = 0; i < depth; i++) {
    const boundary = `B${i}`;
    body = `--${boundary}\r\n${body}--${boundary}--\r\n`;
    body = `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${body}`;
  }
  return `From: owner@acme.com\r\nTo: venturesdatasolutions@gmail.com\r\nSubject: bomb\r\n${body}`;
}

function createThrowingImagesBinding() {
  return {
    input() { throw new Error('IMAGES unavailable'); },
  };
}

function createDbThrowingOnHouses(responses) {
  const base = createFakeD1(responses);
  return {
    calls: base.calls,
    prepare(sql) {
      if (sql.startsWith('SELECT * FROM houses')) {
        return {
          bind() { return this; },
          async all() { throw new Error('DB unavailable'); },
          async first() { throw new Error('DB unavailable'); },
        };
      }
      return base.prepare(sql);
    },
  };
}

function baseEnv(db, overrides = {}) {
  return {
    DB: db,
    RECEIPTS_BUCKET: createFakeR2Bucket(),
    IMAGES: createFakeImagesBinding(new ArrayBuffer(4)),
    CONVERSATION_STATE: createFakeKV(),
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    RECEIPTS_EMAIL_ADDRESS: 'venturesdatasolutions@gmail.com',
    ...overrides,
  };
}

function getRawHandler(raw) {
  return ['format=raw', jsonOk({ raw: base64UrlEncode(Buffer.from(raw, 'utf8')) })];
}

async function main() {
  const client = { id: 1, business_name: 'Acme Rentals', twilio_number: '+15559876543' };
  const singleHouse = [{ id: 10, client_id: 1, address: '123 Main St', nickname: 'Main St', google_sheet_id: 'sheet_abc' }];
  const twoHouses = [
    singleHouse[0],
    { id: 11, client_id: 1, address: '456 Oak Ave', nickname: 'Oak Ave', google_sheet_id: 'sheet_def' },
  ];

  // 1. Valid receipt email, with a photo attachment, from a recognized EMAIL-ONLY sender
  // -> files the expense, sends a threaded confirmation reply, marks the message read
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 7, client_id: 1, phone_number: null, email: 'owner@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const env = baseEnv(db);
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'venturesdatasolutions@gmail.com',
      subject: 'Receipt', messageId: '<msg1@acme.com>', textBody: 'Home Depot receipt attached',
      attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const fetchImpl = dispatchFetch([
      getRawHandler(raw),
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_abc', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Home Depot', amount: 42.5, category: 'Materials', confidence: 0.9, raw_text: 'HD $42.50' }),
        copy: 'Logged: $42.50, Materials, Main St.',
      })],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent1' })],
    ]);

    await processGmailMessage({ messageId: 'm1', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert, 'a valid receipt email must insert an expenses row');
    assert(expenseInsert.params[8] === null && expenseInsert.params[9] === 'owner@acme.com', 'the expense must be logged under logged_by_email, not logged_by_phone');
    const sendCall = fetchImpl.calls.find((c) => c.url.includes('/messages/send'));
    assert(sendCall, 'a confirmation reply must be sent');
    const sentBody = JSON.parse(sendCall.init.body);
    assert(sentBody.raw, 'the send call must carry a base64url-encoded raw message');
    const decodedReply = Buffer.from(sentBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert(decodedReply.includes('To: owner@acme.com'), 'the reply must be addressed back to the sender');
    assert(decodedReply.includes('In-Reply-To: <msg1@acme.com>'), 'the reply must thread via In-Reply-To when the inbound message has a Message-ID');
    assert(decodedReply.includes('Auto-Submitted: auto-replied'), "every outbound reply must be marked Auto-Submitted: auto-replied so it can't itself trigger a reply-loop");
    const modifyCall = fetchImpl.calls.find((c) => c.url.includes('/modify'));
    assert(modifyCall, 'the message must be marked read after successful processing');
    const cachedReply = await env.CONVERSATION_STATE.get('processed:m1');
    assert(cachedReply === 'Logged: $42.50, Materials, Main St.', 'the reply must be cached under the Gmail message id for dedup');
  }

  // 2. Unrecognized sender -> a reply with the standard rejection text is sent, message marked
  // read (terminal classification, not worth retrying), no D1 writes
  {
    const db = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const env = baseEnv(db);
    const raw = buildRawMime({
      from: 'stranger@example.com', to: 'venturesdatasolutions@gmail.com',
      subject: 'Receipt', messageId: '<msg2@example.com>', textBody: 'some text',
    });
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})], ['/messages/send', jsonOk({ id: 'sent2' })]]);

    await processGmailMessage({ messageId: 'm2', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    assert(!db.calls.some((c) => c.sql.includes('INSERT')), 'no writes of any kind must happen for an unrecognized sender');
    const sendCall = fetchImpl.calls.find((c) => c.url.includes('/messages/send'));
    assert(sendCall, 'an unrecognized sender must still get a reply explaining why, since Gmail cannot SMTP-reject an already-delivered message');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'an unrecognized sender is a terminal classification and must be marked read');
  }

  // 3. Ambiguous house -> clarification reply sent + marked read; a follow-up poll for the
  // same sender address (matched by KV state, not headers) resolves it
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 8, client_id: 1, phone_number: null, email: 'multi@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': twoHouses,
      'SELECT * FROM pending_review WHERE id = ?': { id: 1, client_id: 1, house_id: null, amount_guess: 10, category_guess: 'Materials', photo_r2_key: null, raw_text: 'Lowes $10', confidence: 0.95 },
    });
    const kv = createFakeKV();
    const env = baseEnv(db, { CONVERSATION_STATE: kv });

    const firstRaw = buildRawMime({ from: 'multi@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Receipt', messageId: '<msg3@acme.com>', textBody: 'Lowes $10' });
    const firstFetch = dispatchFetch([
      getRawHandler(firstRaw),
      ['openrouter.ai', openRouterRouter({
        parse: JSON.stringify({ vendor: 'Lowes', amount: 10, category: 'Materials', confidence: 0.95, raw_text: 'Lowes $10' }),
        copy: 'Which house is this for?',
      })],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent3' })],
    ]);
    await processGmailMessage({ messageId: 'm3', accessToken: 'ya29.tok', env, deps: { fetchImpl: firstFetch } });

    assert(firstFetch.calls.some((c) => c.url.includes('/messages/send')), 'an ambiguous house must still produce a clarification reply');
    const awaitingHouseCall = kv.calls.find((c) => c.method === 'put' && c.key === 'awaiting_house:multi@acme.com');
    assert(awaitingHouseCall, 'an ambiguous house must open an awaiting_house KV state keyed by the sender EMAIL address');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'an ambiguous house must not file anything yet');

    const secondRaw = buildRawMime({
      from: 'multi@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Re: Receipt', messageId: '<msg4@acme.com>',
      textBody: 'Oak Ave\n\nOn Mon wrote:\n> Which house is this for?',
    });
    const secondFetch = dispatchFetch([
      getRawHandler(secondRaw),
      ['sheets.googleapis.com', jsonOk({ spreadsheetId: 'sheet_def', updates: { updatedRange: 'Sheet1!A2:I2' } })],
      ['openrouter.ai', openRouterRouter({ match: JSON.stringify({ house_id: 11 }), copy: 'Logged: $10.00, Materials, Oak Ave.' })],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent4' })],
    ]);
    await processGmailMessage({ messageId: 'm4', accessToken: 'ya29.tok', env, deps: { fetchImpl: secondFetch } });

    const expenseInsert = db.calls.find((c) => c.sql.includes('INSERT INTO expenses'));
    assert(expenseInsert && expenseInsert.params[0] === 11, 'the follow-up reply must file the expense under the house it named (Oak Ave, house_id 11)');
  }

  // 4. Malformed MIME that postal-mime cannot parse -> logged and marked read, no reply (the
  // sender address can't even be extracted), no D1 access, no throw (this runs on a fully
  // public, pre-authentication path)
  {
    const db = createFakeD1();
    const env = baseEnv(db);
    const raw = buildDeeplyNestedMime(300);
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})]]);

    let threw = false;
    try {
      await processGmailMessage({ messageId: 'm5', accessToken: 'ya29.tok', env, deps: { fetchImpl } });
    } catch {
      threw = true;
    }
    assert(!threw, 'a MIME parse failure must never throw — it must be caught and the message dropped gracefully');
    assert(db.calls.length === 0, 'no DB access at all must happen when the email cannot even be parsed');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/messages/send')), 'no reply can be sent when parsing fails, since the sender address cannot be extracted');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'a permanently unparseable message must still be marked read so it does not retry forever');
  }

  // 5. A transient photo-storage failure (R2/Images hiccup) must propagate (throw), leaving the
  // message unread so the next poll retries it automatically — no reply is sent since nothing
  // is final yet
  {
    const db = createFakeD1({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 9, client_id: 1, phone_number: null, email: 'owner2@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
      'SELECT * FROM houses WHERE client_id = ?': singleHouse,
    });
    const env = baseEnv(db, { IMAGES: createThrowingImagesBinding() });
    const raw = buildRawMime({
      from: 'owner2@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Receipt', messageId: '<msg5@acme.com>',
      textBody: 'Home Depot receipt attached', attachmentBase64: Buffer.from('fake-jpeg-bytes').toString('base64'),
    });
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})], ['/messages/send', jsonOk({ id: 'sent5' })]]);

    let threw = false;
    try {
      await processGmailMessage({ messageId: 'm6', accessToken: 'ya29.tok', env, deps: { fetchImpl } });
    } catch {
      threw = true;
    }
    assert(threw, 'a transient photo-storage failure must propagate so the caller leaves the message unread for a retry');
    assert(!db.calls.some((c) => c.sql.includes('INSERT INTO expenses')), 'nothing must be filed when photo storage fails');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/modify')), 'a transient failure must NOT mark the message read — that would prevent the automatic retry');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/messages/send')), 'no reply must be sent on a transient failure — the retry itself is silent');
  }

  // 6. A transient processing failure (e.g. a Sheets API blip) must also propagate
  {
    const db = createDbThrowingOnHouses({
      'SELECT * FROM authorized_senders WHERE email = ?': { id: 10, client_id: 1, phone_number: null, email: 'owner3@acme.com' },
      'SELECT * FROM clients WHERE id = ?': client,
    });
    const env = baseEnv(db);
    const raw = buildRawMime({ from: 'owner3@acme.com', to: 'venturesdatasolutions@gmail.com', subject: 'Receipt', messageId: '<msg6@acme.com>', textBody: 'Home Depot $20' });
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})]]);

    let threw = false;
    try {
      await processGmailMessage({ messageId: 'm7', accessToken: 'ya29.tok', env, deps: { fetchImpl } });
    } catch {
      threw = true;
    }
    assert(threw, 'a transient processing failure must propagate so the caller leaves the message unread for a retry');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/modify')), 'a transient failure must not be marked read');
  }

  // 7. An auto-generated inbound message (Auto-Submitted header) is dropped: not processed, not
  // replied to (replying risks a mail loop), but IS marked read so it doesn't retry forever
  {
    const db = createFakeD1();
    const env = baseEnv(db);
    const boundary = 'BOUNDARY123';
    const raw = [
      'From: owner@acme.com', 'To: venturesdatasolutions@gmail.com', 'Subject: Out of office',
      'Message-ID: <auto1@acme.com>', 'Auto-Submitted: auto-replied',
      `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', 'I am out of office.', '',
      `--${boundary}--`, '',
    ].join('\r\n');
    const fetchImpl = dispatchFetch([getRawHandler(raw), ['/modify', jsonOk({})]]);

    await processGmailMessage({ messageId: 'm8', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    assert(db.calls.length === 0, 'an auto-submitted message must never reach sender/client resolution or any DB access');
    assert(!fetchImpl.calls.some((c) => c.url.includes('/messages/send')), 'an auto-submitted message must never get a reply — replying risks a mail loop');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'an auto-submitted message must still be marked read so it does not retry forever');
  }

  // 8. An already-cached message id (a prior poll filed it but a later step, e.g. markMessageRead,
  // never completed) is not reprocessed — just marked read
  {
    const db = createFakeD1();
    const kv = createFakeKV({ 'processed:m9': 'Logged: $5.00, Materials, Main St.' });
    const env = baseEnv(db, { CONVERSATION_STATE: kv });
    const fetchImpl = dispatchFetch([['/modify', jsonOk({})]]);

    await processGmailMessage({ messageId: 'm9', accessToken: 'ya29.tok', env, deps: { fetchImpl } });

    assert(db.calls.length === 0, 'an already-cached message must not touch the DB at all');
    assert(!fetchImpl.calls.some((c) => c.url.includes('format=raw')), 'an already-cached message must not even be re-fetched');
    assert(fetchImpl.calls.some((c) => c.url.includes('/modify')), 'an already-cached message must still be marked read');
  }

  // pollGmailInbox: processes each listed message, isolating one message's failure from the
  // rest of the batch
  {
    const db = createFakeD1({ 'SELECT * FROM authorized_senders WHERE email = ?': null });
    const env = baseEnv(db, { GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csec', GMAIL_REFRESH_TOKEN: 'rtok' });
    const raw1 = buildRawMime({ from: 'a@x.com', to: 'venturesdatasolutions@gmail.com', subject: 'r1', messageId: '<a@x.com>', textBody: 'hi' });
    const fetchImpl = dispatchFetch([
      ['oauth2.googleapis.com', jsonOk({ access_token: 'ya29.tok', expires_in: 3600 })],
      ['gmail.googleapis.com/gmail/v1/users/me/messages?', jsonOk({ messages: [{ id: 'good' }, { id: 'bad' }] })],
      [`messages/good?format=raw`, jsonOk({ raw: base64UrlEncode(Buffer.from(raw1, 'utf8')) })],
      [`messages/bad?format=raw`, async () => { throw new Error('network blip'); }],
      ['/modify', jsonOk({})],
      ['/messages/send', jsonOk({ id: 'sent' })],
    ]);

    const result = await pollGmailInbox(env, { fetchImpl });
    assert(result.messageCount === 2, 'must report the total number of messages listed');
    assert(result.processedCount === 1, "one message's failure must not prevent the other from being processed");
  }

  console.log('PASS: gmail-poll.test.js');
}

await main();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd expense-intake && node test/gmail-poll.test.js`
Expected: FAIL — `Cannot find module '../src/gmail-poll.js'`

- [ ] **Step 3: Implement**

Create `expense-intake/src/gmail-poll.js`:

```js
// expense-intake/src/gmail-poll.js
import { getGmailAccessToken } from './gmail-auth.js';
import { listUnreadMessageIds, getRawMessage, markMessageRead, sendGmailMessage } from './gmail-client.js';
import { parseInboundEmail, extractReceiptAttachment, stripQuotedReplyText, normalizeEmailAddress, UNKNOWN_SENDER_REJECT_REASON } from './email-intake.js';
import { generateReceiptKey, storeReceiptPhotoFromBytes } from './receipt-storage.js';
import { processResolvedExpenseMessage } from './expense-flow.js';
import { findClientById, findAuthorizedSenderByEmail } from './db.js';
import { getCachedReply, cacheReply } from './message-dedup.js';

const MAX_MESSAGES_PER_POLL = 25;

export async function pollGmailInbox(env, deps = {}) {
  const fetchImpl = deps.fetchImpl;
  const accessToken = await getGmailAccessToken({
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
    kv: env.CONVERSATION_STATE,
    fetchImpl,
  });

  const messageIds = await listUnreadMessageIds({ accessToken, maxResults: MAX_MESSAGES_PER_POLL, fetchImpl });

  let processedCount = 0;
  for (const messageId of messageIds) {
    try {
      await processGmailMessage({ messageId, accessToken, env, deps });
      processedCount++;
    } catch (err) {
      // One message's failure (parse error, DB hiccup, Gmail API blip) must never stop the
      // rest of the batch from being polled — log and move on, same reasoning already used
      // for sendMonthlyNudges' per-sender try/catch in scheduled.js. Leaving this message
      // unread (processGmailMessage never called markMessageRead on the failing path) means
      // the next poll retries it automatically.
      console.error('Failed to process Gmail message', { messageId, error: err.message });
    }
  }
  return { processedCount, messageCount: messageIds.length };
}

export async function processGmailMessage({ messageId, accessToken, env, deps = {} }) {
  const fetchImpl = deps.fetchImpl;

  const cachedReply = await getCachedReply(env.CONVERSATION_STATE, messageId);
  if (cachedReply !== null) {
    // Already fully processed on a prior poll (e.g. markMessageRead failed after we'd already
    // filed the expense and cached the reply) — don't refile, just make sure it's marked read
    // so it stops showing up in is:unread on the next poll.
    await markMessageRead({ accessToken, messageId, fetchImpl });
    return;
  }

  const rawBuffer = await getRawMessage({ accessToken, messageId, fetchImpl });

  let parsed;
  try {
    parsed = await parseInboundEmail(rawBuffer);
  } catch (err) {
    // This runs on a fully public, pre-authentication path — a malformed or adversarial
    // message must never throw out of here. Unlike Cloudflare's setReject, there's no sender
    // address to reply to when parsing itself fails, so this is a silent drop, not a bounce —
    // marked read so it doesn't retry forever.
    console.error('Failed to parse inbound Gmail message, dropping', { messageId, error: err.message });
    await markMessageRead({ accessToken, messageId, fetchImpl });
    return;
  }

  // Auto-generated mail (vacation autoresponders, bounces, etc.) must never be processed or
  // replied to — replying to an autoresponder is exactly how mail-loop storms start.
  if (parsed.autoSubmitted && parsed.autoSubmitted.toLowerCase() !== 'no') {
    await markMessageRead({ accessToken, messageId, fetchImpl });
    return;
  }

  const fromAddress = normalizeEmailAddress(parsed.from);

  const sender = await findAuthorizedSenderByEmail(env.DB, fromAddress);
  const client = sender ? await findClientById(env.DB, sender.client_id) : null;
  if (!sender || !client) {
    // Gmail has already delivered this message to the inbox — there's no SMTP-level reject
    // available the way Cloudflare Email Routing had. The closest equivalent feedback is a
    // normal reply carrying the same rejection text. This is a terminal classification (the
    // sender will never resolve without an onboarding change), so it's marked read rather than
    // retried every 2 minutes.
    await sendGmailMessage({
      accessToken, to: fromAddress, from: env.RECEIPTS_EMAIL_ADDRESS,
      subject: `Re: ${parsed.subject || 'Your receipt'}`,
      text: UNKNOWN_SENDER_REJECT_REASON,
      headers: { 'Auto-Submitted': 'auto-replied' },
      fetchImpl,
    });
    await markMessageRead({ accessToken, messageId, fetchImpl });
    return;
  }

  let photoR2Key = null;
  const attachment = extractReceiptAttachment(parsed.attachments);
  if (attachment) {
    photoR2Key = generateReceiptKey(fromAddress);
    // Deliberately not caught here: a photo-storage failure is transient (R2/Images hiccup)
    // and must propagate so pollGmailInbox's outer catch leaves this message unread for a
    // retry on the next poll, instead of silently losing the receipt.
    await storeReceiptPhotoFromBytes({ bytes: attachment.bytes, imagesBinding: env.IMAGES, bucket: env.RECEIPTS_BUCKET, key: photoR2Key });
  }

  const fields = { from: fromAddress, to: env.RECEIPTS_EMAIL_ADDRESS, body: stripQuotedReplyText(parsed.text), channel: 'email' };

  // Also deliberately not caught: a processing failure (Sheets/D1 blip) must propagate the
  // same way, for the same reason.
  const { smsBody } = await processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps });

  if (!smsBody) {
    await markMessageRead({ accessToken, messageId, fetchImpl });
    return;
  }

  await cacheReply(env.CONVERSATION_STATE, messageId, smsBody);

  const replyHeaders = { 'Auto-Submitted': 'auto-replied' };
  if (parsed.messageId) {
    replyHeaders['In-Reply-To'] = parsed.messageId;
    replyHeaders.References = parsed.messageId;
  }

  try {
    await sendGmailMessage({
      accessToken, to: fromAddress, from: env.RECEIPTS_EMAIL_ADDRESS,
      subject: `Re: ${parsed.subject || 'Your receipt'}`,
      text: smsBody,
      headers: replyHeaders,
      fetchImpl,
    });
  } catch (err) {
    // A send failure here happens after the expense is already filed and the reply is already
    // cached — never let it propagate and cause a duplicate-filing retry (same reasoning as
    // the old handleEmailWebhook's send-failure handling).
    console.error('Failed to send Gmail confirmation reply', { messageId, error: err.message });
  }

  await markMessageRead({ accessToken, messageId, fetchImpl });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd expense-intake && node test/gmail-poll.test.js`
Expected: `PASS: gmail-poll.test.js`

- [ ] **Step 5: Add to the test runner**

In `expense-intake/test/run-all.js`, add `import './gmail-poll.test.js';` right after `import './gmail-auth.test.js';`.

- [ ] **Step 6: Commit**

```bash
git add expense-intake/src/gmail-poll.js expense-intake/test/gmail-poll.test.js expense-intake/test/run-all.js
git commit -m "Add gmail-poll.js: Gmail-based inbound processing, replaces handleEmailWebhook

Same sender resolution / photo storage / expense-filing pipeline as the
Cloudflare-based handleEmailWebhook, adapted to a poll-and-list model:
dedup via the existing message-dedup.js keyed by Gmail message id,
transient failures left unread for automatic retry on the next poll
instead of an SMTP-level reject (which Gmail's API has no equivalent for
on an already-delivered message)."
```

---

### Task 5: Remove the Cloudflare email plumbing and wire in the Gmail poll cron

Removes `handleEmailWebhook` and the `email()` export, and wires `pollGmailInbox` into `scheduled()`. Bundled as one task because the old tests referencing the code being deleted must come out in the same commit, or `node test/run-all.js` breaks partway through this change.

**Files:**
- Modify: `expense-intake/src/handlers.js`
- Modify: `expense-intake/src/index.js`
- Modify: `expense-intake/test/index.test.js`
- Modify: `expense-intake/test/run-all.js`
- Delete: `expense-intake/test/email-handlers.test.js`
- Delete: `expense-intake/test/fake-email-message.js`
- Delete: `expense-intake/test/fake-email-send.js`

- [ ] **Step 1: Trim `handlers.js`'s imports**

In `expense-intake/src/handlers.js`, replace the import block (current lines 1-10):

```js
// expense-intake/src/handlers.js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto, storeReceiptPhotoFromBytes } from './receipt-storage.js';
import { processExpenseMessage, processResolvedExpenseMessage } from './expense-flow.js';
import { buildTwiml } from './twiml.js';
import { getCachedReply, cacheReply } from './message-dedup.js';
import { findClientById, findAuthorizedSenderByEmail, insertSmsConsent } from './db.js';
import { buildVCard } from './vcard.js';
import { SMS_CONSENT_TEXT, normalizePhoneNumber, isValidNormalizedPhone, buildConsentFormHtml, buildConsentConfirmationHtml, escapeHtml } from './consent.js';
import { parseInboundEmail, extractReceiptAttachment, stripQuotedReplyText, normalizeEmailAddress, UNKNOWN_SENDER_REJECT_REASON } from './email-intake.js';
```

with:

```js
// expense-intake/src/handlers.js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';
import { processExpenseMessage } from './expense-flow.js';
import { buildTwiml } from './twiml.js';
import { getCachedReply, cacheReply } from './message-dedup.js';
import { findClientById, insertSmsConsent } from './db.js';
import { buildVCard } from './vcard.js';
import { SMS_CONSENT_TEXT, normalizePhoneNumber, isValidNormalizedPhone, buildConsentFormHtml, buildConsentConfirmationHtml } from './consent.js';
```

- [ ] **Step 2: Delete `handleEmailWebhook` and its constant**

In `expense-intake/src/handlers.js`, delete everything from the `TRANSIENT_ERROR_REJECT_REASON` constant through the end of `handleEmailWebhook` (the entire block starting at the `const TRANSIENT_ERROR_REJECT_REASON =` line, through the comment above `handleEmailWebhook`, through the function's closing `}` at the end of the file). Nothing should follow `handlePostConsent` in the file after this deletion.

- [ ] **Step 3: Wire the Gmail poll cron into `index.js`**

Replace the full contents of `expense-intake/src/index.js`:

```js
import { handleSmsWebhook, handleGetReceipt, handleGetContactCard, handleGetConsentForm, handlePostConsent } from './handlers.js';
import { purgeExpiredPendingReviews, sendMonthlyNudges } from './scheduled.js';
import { pollGmailInbox } from './gmail-poll.js';

const DAILY_PURGE_CRON = '0 3 * * *';
const MONTHLY_NUDGE_CRON = '0 9 1 * *';
const GMAIL_POLL_CRON = '*/2 * * * *';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sms') {
      const bodyText = await request.text();
      const signature = request.headers.get('X-Twilio-Signature') || '';
      const result = await handleSmsWebhook({ url: request.url, bodyText, signature, env });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice('/receipts/'.length));
      } catch {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
      const result = await handleGetReceipt({ key, bucket: env.RECEIPTS_BUCKET });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/contact-card/')) {
      const clientId = url.pathname.slice('/contact-card/'.length);
      const result = await handleGetContactCard({ clientId, db: env.DB });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname === '/consent') {
      const result = handleGetConsentForm();
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'POST' && url.pathname === '/consent') {
      const bodyText = await request.text();
      const result = await handlePostConsent({ bodyText, db: env.DB });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_PURGE_CRON) {
      await purgeExpiredPendingReviews(env);
      return;
    }
    if (event.cron === MONTHLY_NUDGE_CRON) {
      await sendMonthlyNudges(env);
      return;
    }
    if (event.cron === GMAIL_POLL_CRON) {
      await pollGmailInbox(env);
      return;
    }
    console.error('Unrecognized cron trigger fired', { cron: event.cron });
  },
};
```

- [ ] **Step 4: Update `test/index.test.js`**

In `expense-intake/test/index.test.js`, remove the two now-dead imports (`createFakeEmailMessage` and `createFakeEmailSender`) from the top import block, leaving:

```js
import crypto from 'node:crypto';
import workerModule from '../src/index.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';
import { createFakeD1 } from './fake-d1.js';
import { createFakeKV } from './fake-kv.js';
```

Delete the entire `email(): the real Worker export routes an inbound email to handleEmailWebhook` block (the block that calls `workerModule.email(...)`).

In its place, add a test that the Gmail-poll cron routes through the real `scheduled()` handler:

```js
  // scheduled(): the Gmail-poll cron routes to pollGmailInbox through the real handler
  {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.tok', expires_in: 3600 }) };
      }
      if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages?')) {
        return { ok: true, status: 200, json: async () => ({}) }; // no unread messages
      }
      throw new Error(`Unhandled fetch in test: ${url}`);
    };
    try {
      await workerModule.scheduled({ cron: '*/2 * * * *' }, baseEnv({
        DB: createFakeD1(),
        GMAIL_CLIENT_ID: 'cid',
        GMAIL_CLIENT_SECRET: 'csec',
        GMAIL_REFRESH_TOKEN: 'rtok',
        RECEIPTS_EMAIL_ADDRESS: 'venturesdatasolutions@gmail.com',
      }), {});
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert(calls.some((c) => c.url.includes('gmail.googleapis.com/gmail/v1/users/me/messages?')), 'the Gmail-poll cron must route to pollGmailInbox and call messages.list through the real scheduled handler');
  }
```

Place this new block right after the existing "an unrecognized cron string must not throw" block and before the final `console.log('PASS: index.test.js');`.

- [ ] **Step 5: Delete the obsolete Cloudflare-email test fakes and test file**

```bash
rm expense-intake/test/email-handlers.test.js expense-intake/test/fake-email-message.js expense-intake/test/fake-email-send.js
```

- [ ] **Step 6: Update `test/run-all.js`**

In `expense-intake/test/run-all.js`, remove the `import './email-handlers.test.js';` line.

- [ ] **Step 7: Run the full test suite**

Run: `cd expense-intake && node test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 8: Commit**

```bash
git add expense-intake/src/handlers.js expense-intake/src/index.js expense-intake/test/index.test.js expense-intake/test/run-all.js
git rm expense-intake/test/email-handlers.test.js expense-intake/test/fake-email-message.js expense-intake/test/fake-email-send.js
git commit -m "Replace Cloudflare email() handler with the Gmail poll cron

Removes handleEmailWebhook and the email() Worker export entirely —
pollGmailInbox (wired into scheduled() on a new */2 * * * * cron) is
now the only inbound email path. Deletes the Cloudflare-specific test
fakes and email-handlers.test.js, whose scenarios are now covered by
gmail-poll.test.js."
```

---

### Task 6: `wrangler.toml` — remove the Cloudflare email binding, add the poll cron

**Files:**
- Modify: `expense-intake/wrangler.toml`

- [ ] **Step 1: Edit**

In `expense-intake/wrangler.toml`, remove the `send_email` block entirely (the comment above it and the `[[send_email]]` / `name = "EMAIL"` lines), change `RECEIPTS_EMAIL_ADDRESS`, and add the new cron. The full file should read:

```toml
name = "expense-intake"
main = "src/index.js"
compatibility_date = "2026-08-17"

[[d1_databases]]
binding = "DB"
database_name = "expense-intake-db"
database_id = "162a1b94-cfbe-4321-81ea-584fb7173a7c"

[vars]
AI_PROVIDER = "openrouter"
WORKER_BASE_URL = "https://expense-intake.venturesdatasolutions.workers.dev"
RECEIPTS_EMAIL_ADDRESS = "venturesdatasolutions@gmail.com"

[[r2_buckets]]
binding = "RECEIPTS_BUCKET"
bucket_name = "expense-intake-receipts"

[images]
binding = "IMAGES"

[[kv_namespaces]]
binding = "CONVERSATION_STATE"
id = "a0e34af4cb9245d7bf906256e49c5db5"

# CONVERSATION_STATE (above) is also used by Build Order steps 5-6 for house-selection
# state, the 10-minute correction window, and the pending-review queue cursor, and now
# also caches the Gmail OAuth access token under the fixed key "gmail_access_token" (see
# src/gmail-auth.js) — one namespace, multiple key prefixes.

[triggers]
crons = [
  "0 3 * * *",   # daily purge — DAILY_PURGE_CRON in src/index.js
  "0 9 1 * *",   # monthly nudge — MONTHLY_NUDGE_CRON in src/index.js
  "*/2 * * * *", # Gmail inbound poll — GMAIL_POLL_CRON in src/index.js
]
```

- [ ] **Step 2: Verify the config parses**

Run: `cd expense-intake && npx wrangler deploy --dry-run`
Expected: no TOML parse errors; wrangler prints the resolved config (it will fail or warn about needing real Gmail secrets to actually deploy — that's expected and fine, this step is only checking the TOML itself is well-formed and the binding list resolves).

- [ ] **Step 3: Commit**

```bash
git add expense-intake/wrangler.toml
git commit -m "wrangler.toml: remove send_email binding, add Gmail poll cron

Cloudflare Email Sending is being dropped entirely in favor of the
Gmail API. RECEIPTS_EMAIL_ADDRESS now points at the Gmail inbox
(venturesdatasolutions@gmail.com) instead of the old Cloudflare Email
Routing subdomain address."
```

---

### Task 7: Update `README.md`

**Files:**
- Modify: `expense-intake/README.md`

- [ ] **Step 1: Replace the "Email handler" section**

Replace the `## Email handler` section (from `## Email handler` through the paragraph ending `...the \`/consent\` SMS opt-in flow.` and the blank line before `## Status`) with:

```markdown
## Email handler

A Cron Trigger (`*/2 * * * *`, `pollGmailInbox` in `src/gmail-poll.js`) polls
`venturesdatasolutions@gmail.com` via the Gmail API — `users.messages.list?q=is:unread`,
then `users.messages.get?format=raw` for each — instead of a push-based inbound
handler (Cloudflare Workers can't run a persistent listener, and Gmail's own push
notifications still need a renewal cron every <7 days regardless, so polling adds
no real overhead versus push here). The raw MIME bytes are parsed with the same
`postal-mime`-based `parseInboundEmail` the old Cloudflare-based handler used, and
the sender is resolved by matching their From address against
`authorized_senders.email` — then it's the exact same parse/categorize/
house-matching/Sheet-filing pipeline SMS uses (`processResolvedExpenseMessage` in
`src/expense-flow.js`).

An unrecognized sender gets a reply carrying a fixed explanation and the message
is marked read — there's no SMTP-level reject available for an already-delivered
Gmail message the way Cloudflare Email Routing had, so a normal reply is the
closest equivalent. A clarification reply (e.g. "which property is this for?") is
matched back to the original message purely by sender address + the same
`CONVERSATION_STATE` KV state SMS already uses (`awaiting_house:<email>` etc.),
not by parsing `In-Reply-To`/`References` — more robust against mail clients that
don't preserve threading headers on reply. Our own replies still set those headers
so the thread displays correctly in the subscriber's inbox.

An inbound message that looks auto-generated (an `Auto-Submitted` header other
than `no` — vacation autoresponders, bounces) is marked read and dropped, not
processed or replied to, to avoid an auto-reply loop; every real reply this
handler sends carries `Auto-Submitted: auto-replied` on its own outbound headers
for the same reason. A transient failure partway through (photo storage, Sheets/AI
calls) is left **unread** rather than replied to — the next poll retries it
automatically, which is the polling model's version of Cloudflare's old
SMTP-reject-with-retry behavior. See `processGmailMessage` in `src/gmail-poll.js`
for the exact error paths, and
`docs/superpowers/specs/2026-08-26-expense-intake-gmail-transport-design.md` for
why polling was chosen over Gmail push notifications.

This channel exists specifically so a subscriber can use the product without ever
opting into SMS — see
`docs/superpowers/specs/2026-08-25-expense-intake-email-channel-design.md`. An
authorized sender can have an `email`, a `phone_number`, or both; only a sender
with a phone number is ever gated behind the `/consent` SMS opt-in flow.

## Status
```

- [ ] **Step 2: Replace the "Email Routing / Sending setup" section**

Replace the `## Email Routing / Sending setup (one-time, per environment)` section (through the paragraph ending `...only turn on Email Routing/Sending for the subdomain.`) with:

```markdown
## Gmail API setup (one-time, per environment)

1. Create (or reuse) a Google Cloud project and enable the **Gmail API**
   (APIs & Services → Library).
2. Configure the **OAuth consent screen**: External user type, add
   `venturesdatasolutions@gmail.com` as a test user, and add the scope
   `https://www.googleapis.com/auth/gmail.modify` (covers list/get/mark-as-read
   *and* send in one scope).
3. **Publish the consent screen to "In production."** `gmail.modify` is a
   Google-classified Restricted scope; while the app sits in "Testing" status,
   Google hard-expires every refresh token after 7 days, which would silently
   break the poll cron weekly. You'll see an "unverified app" warning once during
   the consent flow — click through it, since this is your own app authorizing
   your own account.
4. Create OAuth credentials: Application type = **Desktop app** (not Web) — this
   allows the one-time authorization to happen via a loopback redirect without a
   public callback URL.
5. Run the one-time consent flow to exchange an authorization code for a refresh
   token.
6. Set the three secrets:

```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
```

No DNS or Cloudflare dashboard changes are needed — inbound/outbound mail now
flows entirely through the Gmail API, not Cloudflare Email Routing/Sending.
```

- [ ] **Step 3: Commit**

```bash
git add expense-intake/README.md
git commit -m "README: document the Gmail API transport (replaces Cloudflare Email Routing/Sending docs)"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite one more time**

Run: `cd expense-intake && node test/run-all.js`
Expected: `ALL EXPENSE-INTAKE WORKER TESTS PASSED`

- [ ] **Step 2: Grep for any remaining Cloudflare-email references**

Run: `cd expense-intake && grep -rn "send_email\|handleEmailWebhook\|ForwardableEmailMessage" src/ test/ wrangler.toml`
Expected: no matches (confirms nothing was missed).

- [ ] **Step 3: Confirm the secrets are NOT set yet (they must come from the user)**

Run: `cd expense-intake && npx wrangler secret list`
Expected: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` are absent — these are provided by the user after they complete the one-time OAuth consent flow (Task 7's README section), never invented or placeholder'd by this plan.

---

## Known limitations (not addressed by this plan — flag if they become real problems)

- No retry-count cap on transiently-failing messages: a message that fails `processResolvedExpenseMessage` on every attempt (e.g. a genuine bug, not a blip) will be retried every 2 minutes indefinitely rather than eventually giving up. Visible in Worker logs (`console.error`) if it happens; not worth building a cap for pre-emptively.
- `gmail.modify` is a Google-classified Restricted scope. Publishing the OAuth consent screen to "In production" (Task 7's setup) avoids the 7-day refresh-token expiry without full Google security verification, which is the standard path for personal/low-volume use — but if usage or user count grows, full verification may eventually be required.
- **No mutual-exclusion guard against overlapping cron invocations.** If a `pollGmailInbox` run takes longer than 2 minutes (a full 25-message batch, each with an AI parse call and possibly a Sheets/R2 write, could plausibly exceed this), Cloudflare Cron Triggers do not guarantee the next `*/2 * * * *` firing waits for it to finish. Two overlapping invocations would both see the same message still `UNREAD`, both pass the `getCachedReply` dedup check (neither has cached a reply yet), and both file the expense — producing a duplicate D1/Sheets row for one physical receipt. This is the same failure shape as the sequential-retry duplicate-filing bug fixed during Task 4 review, except no try/catch inside a single invocation can fix a race *between* invocations — it would need a short-TTL "poll in progress" KV lock at the top of `pollGmailInbox`, checked/set atomically-enough for this purpose. Not built here (YAGNI at current message volume, and unconfirmed whether Cloudflare Cron Triggers can actually overlap in practice) — flag it if duplicate expenses are ever observed in production, and add the lock then.
