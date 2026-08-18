// expense-intake/src/twiml.js
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildTwiml(messageBody) {
  if (!messageBody) {
    return '<Response></Response>';
  }
  return `<Response><Message>${escapeXml(messageBody)}</Message></Response>`;
}
