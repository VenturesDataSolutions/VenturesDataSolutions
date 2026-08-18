// expense-intake/test/conversation-state.test.js
import {
  getAwaitingHouse, setAwaitingHouse, clearAwaitingHouse,
  getCorrectionState, setCorrectionState, clearCorrectionState,
  getPendingQueueState, setPendingQueueState, clearPendingQueueState,
} from '../src/conversation-state.js';
import { createFakeKV } from './fake-kv.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // awaiting_house: not set
  const kv1 = createFakeKV();
  const missing = await getAwaitingHouse(kv1, '+15551234567');
  assert(missing === null, 'getAwaitingHouse must return null when nothing is stored for this phone');

  // awaiting_house: set then get, with a 10-minute TTL
  const kv2 = createFakeKV();
  await setAwaitingHouse(kv2, '+15551234567', { pendingReviewId: 99, attempt: 0 });
  const putCall = kv2.calls.find((c) => c.method === 'put');
  assert(putCall.key === 'awaiting_house:+15551234567', 'setAwaitingHouse must key by awaiting_house:<phone>');
  assert(putCall.options.expirationTtl === 600, 'setAwaitingHouse must use a 10-minute (600s) TTL');
  const state = await getAwaitingHouse(kv2, '+15551234567');
  assert(state.pendingReviewId === 99 && state.attempt === 0, 'getAwaitingHouse must return the exact stored state, JSON round-tripped');

  // awaiting_house: clear
  const kv3 = createFakeKV();
  await setAwaitingHouse(kv3, '+15551234567', { pendingReviewId: 1, attempt: 0 });
  await clearAwaitingHouse(kv3, '+15551234567');
  assert((await getAwaitingHouse(kv3, '+15551234567')) === null, 'clearAwaitingHouse must delete the stored state');

  // correction: not set
  const kv4 = createFakeKV();
  const missingCorrection = await getCorrectionState(kv4, '+15551234567');
  assert(missingCorrection === null, 'getCorrectionState must return null when nothing is stored for this phone');

  // correction: set then get, with a 10-minute TTL
  const kv5 = createFakeKV();
  await setCorrectionState(kv5, '+15551234567', { expenseId: 42, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 });
  const correctionPutCall = kv5.calls.find((c) => c.method === 'put');
  assert(correctionPutCall.key === 'correction:+15551234567', 'setCorrectionState must key by correction:<phone>');
  assert(correctionPutCall.options.expirationTtl === 600, 'setCorrectionState must use a 10-minute (600s) TTL');
  const correctionState = await getCorrectionState(kv5, '+15551234567');
  assert(correctionState.expenseId === 42 && correctionState.sheetRow === 5, 'getCorrectionState must return the exact stored state, JSON round-tripped');

  // correction: setting again for the same phone overwrites the previous state (the
  // "always the most recent filed expense" rule from the design spec)
  const kv6 = createFakeKV();
  await setCorrectionState(kv6, '+15551234567', { expenseId: 1, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 });
  await setCorrectionState(kv6, '+15551234567', { expenseId: 2, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 6 });
  const latest = await getCorrectionState(kv6, '+15551234567');
  assert(latest.expenseId === 2, 'a second setCorrectionState call for the same phone must overwrite the first');

  // correction: clear
  const kv7 = createFakeKV();
  await setCorrectionState(kv7, '+15551234567', { expenseId: 1, houseId: 10, spreadsheetId: 'sheet_abc', sheetRow: 5 });
  await clearCorrectionState(kv7, '+15551234567');
  assert((await getCorrectionState(kv7, '+15551234567')) === null, 'clearCorrectionState must delete the stored state');

  // pending_queue: not set
  const kv8 = createFakeKV();
  const missingQueue = await getPendingQueueState(kv8, '+15551234567');
  assert(missingQueue === null, 'getPendingQueueState must return null when nothing is stored for this phone');

  // pending_queue: set then get, with a 24-hour TTL
  const kv9 = createFakeKV();
  await setPendingQueueState(kv9, '+15551234567', { pendingReviewId: 50 });
  const queuePutCall = kv9.calls.find((c) => c.method === 'put');
  assert(queuePutCall.key === 'pending_queue:+15551234567', 'setPendingQueueState must key by pending_queue:<phone>');
  assert(queuePutCall.options.expirationTtl === 86400, 'setPendingQueueState must use a 24-hour (86400s) TTL — an on-demand session, not a time-critical window like awaiting_house/correction');
  const queueState = await getPendingQueueState(kv9, '+15551234567');
  assert(queueState.pendingReviewId === 50, 'getPendingQueueState must return the exact stored state, JSON round-tripped');

  // pending_queue: setting again for the same phone overwrites (advancing the cursor)
  const kv10 = createFakeKV();
  await setPendingQueueState(kv10, '+15551234567', { pendingReviewId: 50 });
  await setPendingQueueState(kv10, '+15551234567', { pendingReviewId: 51 });
  const advanced = await getPendingQueueState(kv10, '+15551234567');
  assert(advanced.pendingReviewId === 51, 'a second setPendingQueueState call for the same phone must overwrite the first (advancing the cursor)');

  // pending_queue: clear
  const kv11 = createFakeKV();
  await setPendingQueueState(kv11, '+15551234567', { pendingReviewId: 50 });
  await clearPendingQueueState(kv11, '+15551234567');
  assert((await getPendingQueueState(kv11, '+15551234567')) === null, 'clearPendingQueueState must delete the stored state');

  console.log('PASS: conversation-state.test.js');
}

await main();
