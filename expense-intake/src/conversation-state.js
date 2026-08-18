// expense-intake/src/conversation-state.js
// House-selection and correction-window state, both scoped by sender phone number and both
// a 10-minute TTL — see Step 5's design spec
// (docs/superpowers/specs/2026-08-18-expense-intake-house-selection-correction-design.md).
// Shares the CONVERSATION_STATE KV namespace Step 4's message-dedup.js already introduced,
// under different key prefixes, rather than a second namespace.
const STATE_TTL_SECONDS = 10 * 60;
const PENDING_QUEUE_TTL_SECONDS = 24 * 60 * 60; // an on-demand session, not a time-critical window — see Step 6's design spec

export async function getAwaitingHouse(kv, phone) {
  const value = await kv.get(`awaiting_house:${phone}`, { type: 'json' });
  return value ?? null;
}

export async function setAwaitingHouse(kv, phone, state) {
  await kv.put(`awaiting_house:${phone}`, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS });
}

export async function clearAwaitingHouse(kv, phone) {
  await kv.delete(`awaiting_house:${phone}`);
}

export async function getCorrectionState(kv, phone) {
  const value = await kv.get(`correction:${phone}`, { type: 'json' });
  return value ?? null;
}

export async function setCorrectionState(kv, phone, state) {
  await kv.put(`correction:${phone}`, JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS });
}

export async function clearCorrectionState(kv, phone) {
  await kv.delete(`correction:${phone}`);
}

export async function getPendingQueueState(kv, phone) {
  const value = await kv.get(`pending_queue:${phone}`, { type: 'json' });
  return value ?? null;
}

export async function setPendingQueueState(kv, phone, state) {
  await kv.put(`pending_queue:${phone}`, JSON.stringify(state), { expirationTtl: PENDING_QUEUE_TTL_SECONDS });
}

export async function clearPendingQueueState(kv, phone) {
  await kv.delete(`pending_queue:${phone}`);
}
