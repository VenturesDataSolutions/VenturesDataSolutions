import { handleSmsWebhook, handleGetReceipt } from './handlers.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/sms') {
      const bodyText = await request.text();
      const signature = request.headers.get('X-Twilio-Signature') || '';
      const result = await handleSmsWebhook({ url: request.url, bodyText, signature, env });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/receipts/')) {
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice('/receipts/'.length));
      } catch {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }
      const result = await handleGetReceipt({ key, bucket: env.RECEIPTS_BUCKET });
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
