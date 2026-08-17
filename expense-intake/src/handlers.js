// expense-intake/src/handlers.js
import { parseFormBody, verifyTwilioSignature, extractWebhookFields } from './twilio.js';
import { generateReceiptKey, storeReceiptPhoto } from './receipt-storage.js';

export async function handleSmsWebhook({ url, bodyText, signature, accountSid, authToken, imagesBinding, bucket, fetchImpl }) {
  const params = parseFormBody(bodyText);
  const valid = await verifyTwilioSignature({ url, params, signature, authToken });
  if (!valid) {
    return { status: 403, contentType: 'text/plain', body: 'Forbidden' };
  }

  const fields = extractWebhookFields(params);
  if (fields.media.length > 0) {
    const key = generateReceiptKey(fields.to);
    try {
      await storeReceiptPhoto({
        mediaUrl: fields.media[0].url,
        accountSid,
        authToken,
        imagesBinding,
        bucket,
        key,
        fetchImpl,
      });
    } catch (err) {
      // Twilio retries webhook delivery on a non-2xx response — surfacing this as a
      // failure (rather than swallowing it and returning 200) gives the photo another
      // chance to be stored instead of being silently lost, per the spec's stated
      // reason for storing before parsing.
      console.error('Failed to store receipt photo', { error: err.message });
      return { status: 500, contentType: 'text/plain', body: 'Failed to store photo' };
    }
  }

  return { status: 200, contentType: 'text/xml', body: '<Response></Response>' };
}
