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
