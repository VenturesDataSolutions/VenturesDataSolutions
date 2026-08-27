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

  // buildRawEmail: strips embedded CR/LF from interpolated values so an attacker-controlled
  // subject (e.g. from a forwarded inbound email) can't inject a bogus extra header line
  {
    const raw = buildRawEmail({
      to: 'owner@acme.com', from: 'venturesdatasolutions@gmail.com',
      subject: 'hijack\r\nBcc: attacker@evil.com',
      text: 'Logged: $42.50, Materials, Main St.',
      headers: { 'In-Reply-To': '<msg1@acme.com>\r\nX-Injected: evil' },
    });
    const decoded = base64UrlDecode(raw).toString('utf8');
    const [headerBlock, ...bodyParts] = decoded.split('\r\n\r\n');
    const headerLines = headerBlock.split('\r\n');
    assert(headerLines.length === 5, `expected exactly 5 header lines (To/From/Subject/Content-Type/In-Reply-To), got ${headerLines.length}: ${JSON.stringify(headerLines)}`);
    assert(!headerLines.some((line) => line.startsWith('Bcc:')), 'a CRLF embedded in subject must not inject a new Bcc header line');
    assert(!headerLines.some((line) => line.startsWith('X-Injected:')), 'a CRLF embedded in a header value must not inject a new X-Injected header line');
    assert(headerLines.some((line) => line === 'Subject: hijack Bcc: attacker@evil.com'), 'the injected CRLF must be folded into a single Subject line, not split');
    assert(bodyParts.join('\r\n\r\n').endsWith('Logged: $42.50, Materials, Main St.'), 'body text must be unaffected');
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
