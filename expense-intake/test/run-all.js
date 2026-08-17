// expense-intake/test/run-all.js
import './schema.test.js';
import './providers/shared.test.js';
import './providers/openrouter.test.js';
import './providers/anthropic.test.js';
import './providers/index.test.js';
import './twilio.test.js';
import './receipt-storage.test.js';
import './handlers.test.js';
import './index.test.js';

console.log('ALL EXPENSE-INTAKE WORKER TESTS PASSED');
