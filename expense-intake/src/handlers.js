// expense-intake/src/handlers.js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';
import { processExpenseMessage } from './expense-flow.js';
import { buildTwiml } from './twiml.js';
import { getCachedReply, cacheReply } from './message-dedup.js';
import { findClientById } from './db.js';
import { buildVCard } from './vcard.js';

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
