// expense-intake/src/email-intake.js
import PostalMime from 'postal-mime';

export function normalizeEmailAddress(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

const QUOTE_LINE_RE = /^>/;
const ON_WROTE_RE = /^On .+wrote:$/i;

// Strips quoted history from a reply email's plain-text body, so the clarification-reply
// text handed to matchHouseFromReply (src/providers/index.js) is just the new content — the
// same shape processExpenseMessage already expects for an SMS body. Cuts at the first line
// that looks like a quote marker or a client-generated "On ... wrote:" preamble; if no such
// line exists, the whole text is kept.
export function stripQuotedReplyText(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  const cutIndex = lines.findIndex((line) => QUOTE_LINE_RE.test(line.trim()) || ON_WROTE_RE.test(line.trim()));
  const kept = cutIndex === -1 ? lines : lines.slice(0, cutIndex);
  return kept.join('\n').trim();
}

// Only the first image attachment is treated as the receipt photo — same "first media item
// only" simplification src/handlers.js already makes for MMS (it reads fields.media[0].url).
export function extractReceiptAttachment(attachments) {
  const image = (attachments || []).find((a) => typeof a.mimeType === 'string' && a.mimeType.startsWith('image/'));
  if (!image) return null;
  return { bytes: image.content, contentType: image.mimeType };
}

export async function parseInboundEmail(rawArrayBuffer) {
  const parsed = await PostalMime.parse(rawArrayBuffer);
  return {
    subject: parsed.subject || '',
    text: parsed.text || '',
    messageId: parsed.messageId || null,
    attachments: parsed.attachments || [],
  };
}

export const UNKNOWN_SENDER_REJECT_REASON =
  'This email address is not registered with VDS Expense Tracker. Contact hello@venturesdatasolutions.com to get set up.';
