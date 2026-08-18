// expense-intake/test/scheduled.test.js
import { purgeExpiredPendingReviews, sendMonthlyNudges } from '../src/scheduled.js';
import { createFakeD1 } from './fake-d1.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const [match, respond] of handlers) {
      if (url.includes(match)) return respond(url, init);
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function chatResponse(content) {
  return { choices: [{ message: { content } }] };
}

function baseEnv(db, overrides = {}) {
  return {
    DB: db,
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or_key',
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'test_auth_token',
    ...overrides,
  };
}

async function main() {
  // purgeExpiredPendingReviews
  {
    const db = createFakeD1({ 'DELETE FROM pending_review WHERE expires_at < ?': { success: true, meta: { changes: 4 } } });
    const result = await purgeExpiredPendingReviews(baseEnv(db));
    assert(result.deletedCount === 4, 'purgeExpiredPendingReviews must return the number of rows deleted');
    const call = db.calls[0];
    assert(call.sql.includes('DELETE FROM pending_review'), 'must delete from pending_review');
    assert(/^\d{4}-\d{2}-\d{2}T/.test(call.params[0]), 'must bind an ISO timestamp as the expiry cutoff');
  }

  // sendMonthlyNudges: no active clients with pending items -> nothing sent
  {
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": [],
    });
    const fetchImpl = fakeFetch([]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 0, 'no active clients with pending items must send nothing');
    assert(fetchImpl.calls.length === 0, 'no fetch calls should happen when there is nothing to nudge about');
  }

  // sendMonthlyNudges: one client, two authorized senders -> both get nudged
  {
    const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 2 }];
    const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }, { id: 6, client_id: 1, phone_number: '+15559998888' }];
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts,
      'SELECT * FROM authorized_senders WHERE client_id = ?': senders,
    });
    const fetchImpl = fakeFetch([
      ['openrouter.ai', async () => ({ ok: true, status: 200, json: async () => chatResponse("2 items waiting on your OK. Text 'pending' to review.") })],
      ['api.twilio.com', async () => ({ ok: true, status: 201, json: async () => ({ sid: 'SM1' }) })],
    ]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 2, 'both authorized senders must be counted as sent');
    const twilioCalls = fetchImpl.calls.filter((c) => c.url.includes('api.twilio.com'));
    assert(twilioCalls.length === 2, 'must send one outbound SMS per authorized sender');
    const toNumbers = twilioCalls.map((c) => new URLSearchParams(c.init.body).get('To'));
    assert(toNumbers.includes('+15551234567') && toNumbers.includes('+15559998888'), 'must send to every authorized sender phone number, not just one');
    const fromNumbers = twilioCalls.map((c) => new URLSearchParams(c.init.body).get('From'));
    assert(fromNumbers.every((from) => from === '+15559876543'), "must send from the client's own twilio_number");
  }

  // sendMonthlyNudges: one sender's send fails -> the other still gets nudged, no throw
  {
    const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 1 }];
    const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }, { id: 6, client_id: 1, phone_number: '+15559998888' }];
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts,
      'SELECT * FROM authorized_senders WHERE client_id = ?': senders,
    });
    let twilioCallCount = 0;
    const fetchImpl = fakeFetch([
      ['openrouter.ai', async () => ({ ok: true, status: 200, json: async () => chatResponse("1 item waiting on your OK. Text 'pending' to review.") })],
      ['api.twilio.com', async () => {
        twilioCallCount++;
        if (twilioCallCount === 1) {
          return { ok: false, status: 400, json: async () => ({ code: 21211, message: 'Invalid To Phone Number' }) };
        }
        return { ok: true, status: 201, json: async () => ({ sid: 'SM2' }) };
      }],
    ]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 1, 'a failed send for one sender must not be counted, but must not stop the other from being sent');
  }

  // sendMonthlyNudges: generateSmsCopy fails -> falls back to static monthly_nudge copy
  {
    const pendingCounts = [{ client_id: 1, twilio_number: '+15559876543', pending_count: 3 }];
    const senders = [{ id: 5, client_id: 1, phone_number: '+15551234567' }];
    const db = createFakeD1({
      "SELECT c.id AS client_id, c.twilio_number AS twilio_number, COUNT(pr.id) AS pending_count FROM clients c JOIN pending_review pr ON pr.client_id = c.id WHERE c.status = 'active' GROUP BY c.id": pendingCounts,
      'SELECT * FROM authorized_senders WHERE client_id = ?': senders,
    });
    const fetchImpl = fakeFetch([
      ['openrouter.ai', async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'upstream error' } }) })],
      ['api.twilio.com', async () => ({ ok: true, status: 201, json: async () => ({ sid: 'SM3' }) })],
    ]);
    const result = await sendMonthlyNudges(baseEnv(db), { fetchImpl });
    assert(result.sentCount === 1, 'a copy-generation failure must not prevent the nudge from being sent with fallback copy');
    const twilioCall = fetchImpl.calls.find((c) => c.url.includes('api.twilio.com'));
    const sentBody = new URLSearchParams(twilioCall.init.body).get('Body');
    assert(sentBody === "3 items waiting on your OK. Text 'pending' to review.", 'the fallback monthly_nudge copy must substitute the real pending count');
  }

  console.log('PASS: scheduled.test.js');
}

await main();
