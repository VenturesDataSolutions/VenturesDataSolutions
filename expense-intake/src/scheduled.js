// expense-intake/src/scheduled.js
import { deleteExpiredPendingReviews, findActiveClientsWithPendingCounts, findAuthorizedSendersForClient } from './db.js';
import { sendSms } from './twilio.js';
import { safeGenerateSmsCopy } from './expense-flow.js';

export async function purgeExpiredPendingReviews(env, deps = {}) {
  const nowIso = new Date().toISOString();
  const deletedCount = await deleteExpiredPendingReviews(env.DB, nowIso);
  console.log('Purged expired pending_review rows', { deletedCount });
  return { deletedCount };
}

export async function sendMonthlyNudges(env, deps = {}) {
  const clients = await findActiveClientsWithPendingCounts(env.DB);
  let sentCount = 0;
  for (const client of clients) {
    const senders = await findAuthorizedSendersForClient(env.DB, client.client_id);
    const body = await safeGenerateSmsCopy('monthly_nudge', { X: client.pending_count }, env, deps);
    for (const sender of senders) {
      try {
        await sendSms({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          from: client.twilio_number,
          to: sender.phone_number,
          body,
          fetchImpl: deps.fetchImpl,
        });
        sentCount++;
      } catch (err) {
        // One sender's outbound send failing (bad number, Twilio hiccup) must not stop the
        // rest of this client's senders, or the next client in the loop, from being nudged.
        console.error('Failed to send monthly nudge', { clientId: client.client_id, phone: sender.phone_number, error: err.message });
      }
    }
  }
  console.log('Sent monthly nudges', { sentCount });
  return { sentCount };
}
