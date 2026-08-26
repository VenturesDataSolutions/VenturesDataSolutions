// expense-intake/test/email-intake.test.js
import {
  normalizeEmailAddress, stripQuotedReplyText, extractReceiptAttachment, parseInboundEmail,
} from '../src/email-intake.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function buildRawMime({ from, to, subject, messageId, textBody, attachmentBase64 }) {
  const boundary = 'BOUNDARY123';
  const headerLines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`];
  if (messageId) headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [...headerLines, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', textBody, ''];
  if (attachmentBase64) {
    parts.push(
      `--${boundary}`,
      'Content-Type: image/jpeg; name="receipt.jpg"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="receipt.jpg"',
      '',
      attachmentBase64,
      ''
    );
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

async function main() {
  // normalizeEmailAddress
  assert(normalizeEmailAddress('  Owner@Acme.com  ') === 'owner@acme.com', 'must trim and lowercase');
  assert(normalizeEmailAddress(undefined) === '', 'a non-string input must normalize to an empty string');

  // stripQuotedReplyText
  assert(
    stripQuotedReplyText('Main St\n\nOn Mon, Aug 25, 2026 at 9:00 AM Jane <jane@acme.com> wrote:\n> Which house is this for?') === 'Main St',
    'must cut at the "On ... wrote:" preamble'
  );
  assert(stripQuotedReplyText('Main St\n> Which house is this for?') === 'Main St', 'must cut at a ">" quote-marker line');
  assert(stripQuotedReplyText('Main St') === 'Main St', 'text with no quoted history must be returned unchanged (trimmed)');
  assert(stripQuotedReplyText(null) === '', 'a non-string input must normalize to an empty string');

  // extractReceiptAttachment
  {
    const found = extractReceiptAttachment([
      { mimeType: 'text/plain', content: new Uint8Array() },
      { mimeType: 'image/jpeg', content: new Uint8Array([1, 2, 3]) },
    ]);
    assert(found.contentType === 'image/jpeg' && found.bytes.length === 3, 'must find and return the first image attachment');
  }
  assert(extractReceiptAttachment([{ mimeType: 'text/plain', content: new Uint8Array() }]) === null, 'must return null when there is no image attachment');
  assert(extractReceiptAttachment([]) === null, 'must return null when there are no attachments at all');
  assert(extractReceiptAttachment(undefined) === null, 'must not throw when attachments is undefined');

  // parseInboundEmail: real MIME parsing via postal-mime, no fakes
  {
    const attachmentBytes = Buffer.from('fake-jpeg-bytes');
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Receipt from Home Depot', messageId: '<abc123@acme.com>',
      textBody: "Here's a receipt.", attachmentBase64: attachmentBytes.toString('base64'),
    });
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.subject === 'Receipt from Home Depot', 'must extract the Subject header');
    assert(parsed.text.trim() === "Here's a receipt.", 'must extract the plain-text body');
    assert(parsed.messageId === '<abc123@acme.com>', 'must extract the Message-ID header');
    assert(parsed.attachments.length === 1, 'must extract the attachment');
    const attachment = extractReceiptAttachment(parsed.attachments);
    assert(attachment && attachment.contentType === 'image/jpeg', 'the parsed attachment must be recognized as an image');
    assert(Buffer.from(attachment.bytes).toString('utf8') === 'fake-jpeg-bytes', 'the attachment bytes must round-trip through base64 decoding correctly');
  }

  // parseInboundEmail: no attachment, no Message-ID
  {
    const raw = buildRawMime({
      from: 'owner@acme.com', to: 'receipts@intake.venturesdatasolutions.com',
      subject: 'Just a note', messageId: '', textBody: 'no attachment here',
    });
    const parsed = await parseInboundEmail(Buffer.from(raw, 'utf8'));
    assert(parsed.messageId === null, 'a missing Message-ID header must normalize to null, not undefined');
    assert(parsed.attachments.length === 0, 'a message with no attachment part must yield an empty attachments array');
  }

  console.log('PASS: email-intake.test.js');
}

await main();
