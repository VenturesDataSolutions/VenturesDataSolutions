import { handleSmsWebhook } from './handlers.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sms') {
      const bodyText = await request.text();
      const signature = request.headers.get('X-Twilio-Signature') || '';
      const result = await handleSmsWebhook({
        url: request.url,
        bodyText,
        signature,
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        imagesBinding: env.IMAGES,
        bucket: env.RECEIPTS_BUCKET,
      });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
