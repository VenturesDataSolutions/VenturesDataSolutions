const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 85;

export function generateReceiptKey(toNumber) {
  return `receipts/${encodeURIComponent(toNumber || 'unknown')}/${Date.now()}-${crypto.randomUUID()}.jpg`;
}

export async function storeReceiptPhoto({ mediaUrl, accountSid, authToken, imagesBinding, bucket, key, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const basicAuth = btoa(`${accountSid}:${authToken}`);
  const mediaResponse = await doFetch(mediaUrl, { headers: { Authorization: `Basic ${basicAuth}` } });
  if (!mediaResponse.ok) {
    throw new Error(`Failed to fetch Twilio media: ${mediaResponse.status}`);
  }

  const transformed = await imagesBinding
    .input(mediaResponse.body)
    .transform({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality: JPEG_QUALITY });
  const jpegBytes = await transformed.response().arrayBuffer();

  await bucket.put(key, jpegBytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return key;
}

// Sibling to storeReceiptPhoto, for a channel where the bytes are already in hand (an email
// attachment parsed via postal-mime) instead of needing a fetch from a Twilio media URL. Same
// resize/recompress/store pipeline either way.
//
// NOTE: the real Cloudflare Images binding has no local emulation (see the README's existing
// caveat) — confirm `.input()` accepts a Uint8Array directly during the first
// `wrangler dev --remote` smoke test of the email path; wrap in `new Response(bytes).body` here
// if it turns out to require a ReadableStream instead.
export async function storeReceiptPhotoFromBytes({ bytes, imagesBinding, bucket, key }) {
  const transformed = await imagesBinding
    .input(bytes)
    .transform({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality: JPEG_QUALITY });
  const jpegBytes = await transformed.response().arrayBuffer();
  await bucket.put(key, jpegBytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return key;
}
