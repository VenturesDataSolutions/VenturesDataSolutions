// expense-intake/test/consent.test.js
import { SMS_CONSENT_TEXT, normalizePhoneNumber, isValidNormalizedPhone, buildConsentFormHtml, buildConsentConfirmationHtml } from '../src/consent.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  // SMS_CONSENT_TEXT: must carry all four required disclosure elements
  assert(/VDS Expense Tracker/.test(SMS_CONSENT_TEXT), 'consent text must name the brand');
  assert(/frequency/i.test(SMS_CONSENT_TEXT), 'consent text must disclose message frequency varies');
  assert(/data rates/i.test(SMS_CONSENT_TEXT), 'consent text must disclose msg & data rates may apply');
  assert(/HELP/.test(SMS_CONSENT_TEXT) && /STOP/.test(SMS_CONSENT_TEXT), 'consent text must include HELP/STOP instructions');

  // normalizePhoneNumber: common US input formats all resolve to the same E.164 form
  assert(normalizePhoneNumber('(555) 123-4567') === '+15551234567', 'must normalize a parenthesized US number to E.164');
  assert(normalizePhoneNumber('555-123-4567') === '+15551234567', 'must normalize a dashed US number to E.164');
  assert(normalizePhoneNumber('15551234567') === '+15551234567', 'must normalize an 11-digit number starting with 1 to E.164');
  assert(normalizePhoneNumber('+15551234567') === '+15551234567', 'an already-E.164 number must pass through unchanged');
  assert(normalizePhoneNumber('  +1 555 123 4567 ') === '+15551234567', 'must strip surrounding whitespace and internal spaces');

  // normalizePhoneNumber: garbage input doesn't crash, just fails downstream validation
  assert(normalizePhoneNumber('') === '', 'empty input normalizes to empty string');
  assert(normalizePhoneNumber('abc') === '', 'non-numeric input normalizes to an empty digit string');

  // isValidNormalizedPhone
  assert(isValidNormalizedPhone('+15551234567') === true, 'a normalized 11-digit US number must be valid');
  assert(isValidNormalizedPhone('5551234567') === false, 'a number missing the leading + must be invalid');
  assert(isValidNormalizedPhone('') === false, 'an empty string must be invalid');
  assert(isValidNormalizedPhone('+123') === false, 'a too-short number must be invalid');

  // buildConsentFormHtml: renders the exact consent language and a required checkbox
  const formHtml = buildConsentFormHtml();
  assert(formHtml.includes('VDS Expense Tracker'), 'form must display the brand name');
  assert(formHtml.includes('Msg frequency varies'), 'form must display the frequency disclosure');
  assert(formHtml.includes('type="checkbox"') && formHtml.includes('required'), 'form must render a required checkbox, not a pre-checked or optional one');
  assert(formHtml.includes('method="POST"') && formHtml.includes('action="/consent"'), 'form must submit to POST /consent');
  assert(!formHtml.includes('class="error"'), 'no error message when none is passed');

  // buildConsentFormHtml: with an error message
  const errorHtml = buildConsentFormHtml({ error: 'Please enter a valid phone number.' });
  assert(errorHtml.includes('Please enter a valid phone number.'), 'form must surface the passed error message');

  // buildConsentFormHtml: error text is escaped, not injected as raw HTML
  const xssHtml = buildConsentFormHtml({ error: '<script>alert(1)</script>' });
  assert(!xssHtml.includes('<script>alert(1)</script>'), 'error message must be HTML-escaped, not rendered as raw markup');

  // buildConsentConfirmationHtml
  const confirmationHtml = buildConsentConfirmationHtml();
  assert(confirmationHtml.includes('STOP'), 'confirmation page must remind the client they can reply STOP to opt out');

  console.log('PASS: consent.test.js');
}

await main();
