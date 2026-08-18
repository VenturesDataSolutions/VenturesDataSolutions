// expense-intake/test/twiml.test.js
import { buildTwiml } from '../src/twiml.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  assert(buildTwiml('') === '<Response></Response>', 'an empty message body must produce a bare empty Response');
  assert(buildTwiml(null) === '<Response></Response>', 'a null message body must produce a bare empty Response');
  assert(buildTwiml('Logged: $42.50, Materials, Main St.') === '<Response><Message>Logged: $42.50, Materials, Main St.</Message></Response>', 'a message body must be wrapped in a <Message> tag');
  assert(buildTwiml('Tom & Jerry <3') === '<Response><Message>Tom &amp; Jerry &lt;3</Message></Response>', 'special XML characters must be escaped so the TwiML stays well-formed');

  console.log('PASS: twiml.test.js');
}

await main();
