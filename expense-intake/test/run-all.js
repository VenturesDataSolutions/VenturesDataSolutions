// expense-intake/test/run-all.js
import './schema.test.js';
import './migration-0002.test.js';
import './migration-0003.test.js';
import './migration-0004.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './email-intake.test.js';
import './consent.test.js';
import './db.test.js';
import './google-auth.test.js';
import './sheets.test.js';
import './twiml.test.js';
import './vcard.test.js';
import './onboarding.test.js';
import './expense-flow.test.js';
import './message-dedup.test.js';
import './conversation-state.test.js';
import './scheduled.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
