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
// Confirmed against the real (non-emulated) Images binding via a live wrangler deploy: `.input()`
// does NOT accept a raw Uint8Array/ArrayBuffer — it needs a ReadableStream, same as
// storeReceiptPhoto's mediaResponse.body above. Wrapping the bytes in a Response gives us that
// stream without an extra dependency.
export async function storeReceiptPhotoFromBytes({ bytes, imagesBinding, bucket, key }) {
  const transformed = await imagesBinding
    .input(new Response(bytes).body)
    .transform({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality: JPEG_QUALITY });
  const jpegBytes = await transformed.response().arrayBuffer();
  await bucket.put(key, jpegBytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return key;
}
