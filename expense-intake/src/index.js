import { handleSmsWebhook, handleGetReceipt, handleGetContactCard, handleGetConsentForm, handlePostConsent, handleEmailWebhook } from './handlers.js';
import { purgeExpiredPendingReviews, sendMonthlyNudges } from './scheduled.js';

const DAILY_PURGE_CRON = '0 3 * * *';
const MONTHLY_NUDGE_CRON = '0 9 1 * *';

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

    if (request.method === 'GET' && url.pathname.startsWith('/contact-card/')) {
      const clientId = url.pathname.slice('/contact-card/'.length);
      const result = await handleGetContactCard({ clientId, db: env.DB });
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'GET' && url.pathname === '/consent') {
      const result = handleGetConsentForm();
      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': result.contentType },
      });
    }

    if (request.method === 'POST' && url.pathname === '/consent') {
      const bodyText = await request.text();
      const result = await handlePostConsent({ bodyText, db: env.DB });
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

  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_PURGE_CRON) {
      await purgeExpiredPendingReviews(env);
      return;
    }
    if (event.cron === MONTHLY_NUDGE_CRON) {
      await sendMonthlyNudges(env);
      return;
    }
    console.error('Unrecognized cron trigger fired', { cron: event.cron });
  },

  async email(message, env) {
    await handleEmailWebhook({ message, env });
  },
};
