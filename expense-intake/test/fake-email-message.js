// expense-intake/test/fake-email-message.js
// Mimics the shape of Cloudflare's ForwardableEmailMessage closely enough to test the
// email() handler's wiring: from/to, a single-use raw ReadableStream, and a spy-able
// setReject. There is no local emulation for real inbound email (same category of gap
// already documented for the Images binding in receipt-storage.js).
export function createFakeEmailMessage({ from, to, raw }) {
  const rejections = [];
  return {
    from,
    to,
    raw: new Response(raw).body,
    setReject(reason) {
      rejections.push(reason);
    },
    _rejections: rejections,
  };
}
