// expense-intake/src/gmail-auth.js
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN_KV_KEY = 'gmail_access_token';
const EXPIRY_SAFETY_MARGIN_SECONDS = 120;

export async function getGmailAccessToken({ clientId, clientSecret, refreshToken, kv, fetchImpl }) {
  const cached = await kv.get(ACCESS_TOKEN_KV_KEY);
  if (cached) return cached;

  const doFetch = fetchImpl || fetch;
  const response = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = (data && data.error_description) || (data && data.error) || `Gmail token refresh failed with status ${response.status}`;
    throw new Error(message);
  }
  if (!data || typeof data.access_token !== 'string') {
    throw new Error('Gmail token response missing access_token');
  }

  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  const ttl = expiresIn - EXPIRY_SAFETY_MARGIN_SECONDS;
  // Cloudflare KV requires a minimum expirationTtl of 60s. Only cache when the
  // margined TTL clears that floor — otherwise skip caching rather than risk
  // handing out the token past its real expiry (see EXPIRY_SAFETY_MARGIN_SECONDS).
  if (ttl >= 60) {
    try {
      await kv.put(ACCESS_TOKEN_KV_KEY, data.access_token, { expirationTtl: ttl });
    } catch (err) {
      // Losing token caching for one call is far better than failing the whole
      // Gmail poll over a KV hiccup — log it and still return the token we already have.
      console.error('Failed to cache Gmail access token', { error: err.message });
    }
  }

  return data.access_token;
}
