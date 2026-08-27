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
