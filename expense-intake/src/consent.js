// expense-intake/src/consent.js
// SMS opt-in consent capture: the checkbox language a client must explicitly agree to before
// their phone number can become an authorized_sender. Kept as a single exported constant so
// the web form, the stored evidentiary record, and the outbound contact-card disclosure can
// never drift out of sync with each other.
export const SMS_CONSENT_TEXT =
  "I agree to receive SMS text messages from VDS Expense Tracker for expense-tracking purposes. " +
  'Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.';

// Normalizes to E.164-ish form so a phone number typed into this form (any common US format)
// matches how it's later entered into an onboarding config.json by staff. Deliberately strict:
// anything that doesn't resolve to a plausible 10-15 digit number is left unnormalized so the
// caller's validation rejects it, rather than silently guessing at a malformed number.
export function normalizePhoneNumber(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (hadPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

export function isValidNormalizedPhone(phone) {
  return /^\+\d{10,15}$/.test(phone);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  label { display: block; margin-top: 16px; font-weight: 600; }
  input[type="tel"] { width: 100%; padding: 8px; font-size: 16px; margin-top: 4px; box-sizing: border-box; }
  .consent-row { display: flex; align-items: flex-start; gap: 8px; margin-top: 20px; font-weight: normal; }
  .consent-row input { margin-top: 4px; }
  .consent-links { margin-top: 8px; margin-left: 24px; font-weight: normal; font-size: 13px; color: #555; }
  .consent-links a { color: #555; }
  button { margin-top: 24px; padding: 10px 20px; font-size: 16px; }
  .error { color: #b00020; margin-top: 12px; }
`;

export function buildConsentFormHtml({ error } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SMS Consent — VDS Expense Tracker</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>SMS Consent — VDS Expense Tracker</h1>
<p>Enter your own mobile number and confirm below to opt in to expense-tracking text messages.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/consent">
  <label for="phone">Your mobile phone number</label>
  <input type="tel" id="phone" name="phone" placeholder="(555) 123-4567" required>
  <label class="consent-row">
    <input type="checkbox" name="consent" value="yes" required>
    <span>${escapeHtml(SMS_CONSENT_TEXT)}</span>
  </label>
  <p class="consent-links">By checking this box you agree to our <a href="https://venturesdatasolutions.com/privacy.html" target="_blank" rel="noopener">Privacy Policy</a> and <a href="https://venturesdatasolutions.com/terms.html" target="_blank" rel="noopener">Terms of Service</a>.</p>
  <button type="submit">Submit</button>
</form>
</body>
</html>
`;
}

export function buildConsentConfirmationHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Consent Recorded — VDS Expense Tracker</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>You're opted in</h1>
<p>Thanks — we've recorded your consent to receive expense-tracking text messages from VDS Expense Tracker. Reply STOP to any message at any time to opt out.</p>
</body>
</html>
`;
}
