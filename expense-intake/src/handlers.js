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

export async function handleSmsWebhook({ url, bodyText, signature, env, deps = {} }) {
  const params = parseFormBody(bodyText);
  const valid = await verifyTwilioSignature({ url, params, signature, authToken: env.TWILIO_AUTH_TOKEN });
  if (!valid) {
    return { status: 403, contentType: 'text/plain', body: 'Forbidden' };
  }

  const fields = extractWebhookFields(params);

  const cachedReply = await getCachedReply(env.CONVERSATION_STATE, fields.messageSid);
  if (cachedReply !== null) {
    // Twilio retried a delivery we already fully processed (our first response was likely
    // slow or dropped) — replay the same reply instead of re-parsing, re-storing the photo,
    // and re-writing to the Sheet/D1 a second time for one physical receipt.
    return { status: 200, contentType: 'text/xml', body: buildTwiml(cachedReply) };
  }

  let photoR2Key = null;
  if (fields.media.length > 0) {
    photoR2Key = generateReceiptKey(fields.to);
    try {
      await storeReceiptPhoto({
        mediaUrl: fields.media[0].url,
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        imagesBinding: env.IMAGES,
        bucket: env.RECEIPTS_BUCKET,
        key: photoR2Key,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      console.error('Failed to store receipt photo', { error: err.message });
      return { status: 500, contentType: 'text/plain', body: 'Failed to store photo' };
    }
  }

  try {
    const { smsBody } = await processExpenseMessage({ fields, photoR2Key, env, deps });
    try {
      await cacheReply(env.CONVERSATION_STATE, fields.messageSid, smsBody);
    } catch (err) {
      // Losing dedup protection for one message is far better than failing the whole
      // response over a KV hiccup — log it and still reply normally.
      console.error('Failed to cache reply for dedup', { error: err.message });
    }
    return { status: 200, contentType: 'text/xml', body: buildTwiml(smsBody) };
  } catch (err) {
    console.error('Failed to process expense message', { error: err.message });
    return { status: 500, contentType: 'text/plain', body: 'Failed to process message' };
  }
}

// This route is deliberately public and unauthenticated — the Sheet's Photo column links
// directly to it. Trust relies on the R2 key's embedded UUID being practically unguessable,
// not on any auth check here. Confirmed project-owner decision (see Step 4's Design
// decisions note in the plan) — not an oversight.
export async function handleGetReceipt({ key, bucket }) {
  if (!key.startsWith('receipts/')) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const object = await bucket.get(key);
  if (!object) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const bytes = await object.arrayBuffer();
  const contentType = (object.httpMetadata && object.httpMetadata.contentType) || 'image/jpeg';
  return { status: 200, contentType, body: bytes };
}

// This route is deliberately public and unauthenticated, same as handleGetReceipt — but for
// a different reason: a vCard isn't sensitive data (just a business name and the client's
// own already-public-facing Twilio number), so there's no unguessable-key requirement here,
// unlike a receipt photo. See Step 8's design spec.
export async function handleGetContactCard({ clientId, db }) {
  const id = Number.parseInt(clientId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const client = await findClientById(db, id);
  if (!client) {
    return { status: 404, contentType: 'text/plain', body: 'Not found' };
  }
  const vcard = buildVCard({ businessName: client.business_name, phoneNumber: client.twilio_number });
  return { status: 200, contentType: 'text/vcard', body: vcard };
}

// Serves the SMS opt-in form a client fills out themselves before their number can be
// entered into onboard-client.js — see migrations/0003_add_sms_consents.sql.
export function handleGetConsentForm() {
  return { status: 200, contentType: 'text/html', body: buildConsentFormHtml() };
}

export async function handlePostConsent({ bodyText, db }) {
  const params = parseFormBody(bodyText);
  const normalizedPhone = normalizePhoneNumber(params.phone || '');
  const checked = params.consent === 'yes';

  if (!checked || !isValidNormalizedPhone(normalizedPhone)) {
    const error = !isValidNormalizedPhone(normalizedPhone)
      ? 'Please enter a valid phone number.'
      : 'You must check the box to consent before submitting.';
    return { status: 400, contentType: 'text/html', body: buildConsentFormHtml({ error }) };
  }

  await insertSmsConsent(db, {
    phoneNumber: normalizedPhone,
    consentText: SMS_CONSENT_TEXT,
    consentedAt: new Date().toISOString(),
  });

  return { status: 200, contentType: 'text/html', body: buildConsentConfirmationHtml() };
}

const TRANSIENT_ERROR_REJECT_REASON =
  'We hit a temporary error processing your receipt — please try resending it in a few minutes.';

// Cloudflare Email Routing's email() handler for receipts@<subdomain> — see src/index.js.
// Unlike Twilio's signature-verified webhook, there's no HMAC to check on inbound email; the
// sender-address lookup against authorized_senders.email IS the trust boundary here, which is
// why it happens before anything else (including photo storage) below.
export async function handleEmailWebhook({ message, env, deps = {} }) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();

  let parsed;
  try {
    parsed = await parseInboundEmail(rawBuffer);
  } catch (err) {
    // This runs on a fully public, pre-authentication path (no signature check exists for
    // inbound email the way Twilio's webhook has one) — a malformed or adversarial message
    // must never be allowed to throw out of this handler.
    console.error('Failed to parse inbound email', { error: err.message });
    message.setReject('We could not read this email — please make sure it is a standard email with a receipt photo attached.');
    return { status: 'rejected', reason: 'parse_failed' };
  }

  // Auto-generated mail (vacation autoresponders, bounces, etc.) must never be processed or
  // replied to — replying to an autoresponder is exactly how mail-loop storms start. Per
  // RFC 3834, such messages carry an Auto-Submitted header other than "no". This is neither
  // processed NOR rejected (rejecting would itself bounce back at the sender, the same loop
  // risk) — it's simply dropped.
  const autoSubmitted = message.headers && message.headers.get('auto-submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    return { status: 'ignored', reason: 'auto_submitted' };
  }

  const fromAddress = normalizeEmailAddress(message.from);

  const sender = await findAuthorizedSenderByEmail(env.DB, fromAddress);
  if (!sender) {
    message.setReject(UNKNOWN_SENDER_REJECT_REASON);
    return { status: 'rejected', reason: 'unrecognized_sender' };
  }
  const client = await findClientById(env.DB, sender.client_id);
  if (!client) {
    // The sender row exists but its client_id doesn't resolve — an orphaned authorized_senders
    // row (a data-integrity bug), not an unrecognized/spam sender. Same external message either
    // way, but a distinct reason string so this is distinguishable from unrecognized_sender in
    // logs/observability.
    message.setReject(UNKNOWN_SENDER_REJECT_REASON);
    return { status: 'rejected', reason: 'client_not_found' };
  }

  let photoR2Key = null;
  const attachment = extractReceiptAttachment(parsed.attachments);
  if (attachment) {
    photoR2Key = generateReceiptKey(fromAddress);
    try {
      await storeReceiptPhotoFromBytes({
        bytes: attachment.bytes,
        imagesBinding: env.IMAGES,
        bucket: env.RECEIPTS_BUCKET,
        key: photoR2Key,
      });
    } catch (err) {
      console.error('Failed to store receipt photo from email', { error: err.message });
      // Per Cloudflare's Email Routing docs, a handler that returns without consuming raw,
      // forwarding, or rejecting causes the email to be silently dropped — worse than the SMS
      // path, which at least 500s so Twilio retries. A transient failure here (R2/Images
      // hiccup) must not make the sender's receipt vanish with zero feedback.
      message.setReject(TRANSIENT_ERROR_REJECT_REASON);
      return { status: 'rejected', reason: 'photo_storage_failed' };
    }
  }

  const fields = {
    from: fromAddress,
    to: message.to,
    body: stripQuotedReplyText(parsed.text),
    channel: 'email',
  };

  let smsBody;
  try {
    ({ smsBody } = await processResolvedExpenseMessage({ client, fields, photoR2Key, env, deps }));
  } catch (err) {
    console.error('Failed to process email expense message', { error: err.message });
    // Same reasoning as the photo-storage-failure path above: a transient failure (Sheets API
    // blip, DB hiccup, etc.) must reject with feedback, not silently drop the email.
    message.setReject(TRANSIENT_ERROR_REJECT_REASON);
    return { status: 'rejected', reason: 'processing_failed' };
  }

  // Defensive: every current path through processResolvedExpenseMessage returns a non-empty
  // smsBody, so this branch is not known to be reachable today. Kept as a guard in case a
  // future change to that shared pipeline (e.g. a new silent-no-op path) reintroduces an empty
  // reply — the email channel should never send a blank confirmation.
  if (!smsBody) {
    return { status: 'ignored' };
  }

  const replyHeaders = { 'Auto-Submitted': 'auto-replied' };
  if (parsed.messageId) {
    replyHeaders['In-Reply-To'] = parsed.messageId;
    replyHeaders.References = parsed.messageId;
  }

  try {
    await env.EMAIL.send({
      to: fromAddress,
      from: env.RECEIPTS_EMAIL_ADDRESS,
      subject: `Re: ${parsed.subject || 'Your receipt'}`,
      text: smsBody,
      html: `<p>${escapeHtml(smsBody)}</p>`,
      headers: replyHeaders,
    });
  } catch (err) {
    // A send failure here happens after the expense has already been logged to Sheets/D1 —
    // never let it propagate and look like the whole request failed (same reasoning as
    // safeGenerateSmsCopy's fallback path for the SMS side).
    console.error('Failed to send email confirmation reply', { error: err.message });
  }

  return { status: 'sent', replyBody: smsBody };
}
