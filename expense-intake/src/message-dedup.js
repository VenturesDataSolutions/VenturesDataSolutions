// expense-intake/src/message-dedup.js
const REPLY_CACHE_TTL_SECONDS = 24 * 60 * 60; // comfortably longer than any realistic Twilio retry window

export async function getCachedReply(kv, messageSid) {
  if (!messageSid) {
    console.warn('getCachedReply called with an empty messageSid — dedup protection skipped');
    return null;
  }
  return kv.get(`processed:${messageSid}`);
}

export async function cacheReply(kv, messageSid, smsBody) {
  if (!messageSid) {
    console.warn('cacheReply called with an empty messageSid — reply not cached');
    return;
  }
  await kv.put(`processed:${messageSid}`, smsBody, { expirationTtl: REPLY_CACHE_TTL_SECONDS });
}
