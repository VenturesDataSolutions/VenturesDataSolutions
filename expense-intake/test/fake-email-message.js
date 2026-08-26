// expense-intake/test/fake-email-message.js
// Mimics the shape of Cloudflare's ForwardableEmailMessage closely enough to test the
// email() handler's wiring: from/to, a single-use raw ReadableStream, a headers Headers
// object (mirroring the real binding's ForwardableEmailMessage.headers), and a spy-able
// setReject. There is no local emulation for real inbound email (same category of gap
// already documented for the Images binding in receipt-storage.js).
export function createFakeEmailMessage({ from, to, raw, headers = {} }) {
  const rejections = [];
  return {
    from,
    to,
    raw: new Response(raw).body,
    headers: new Headers(headers),
    setReject(reason) {
      rejections.push(reason);
    },
    _rejections: rejections,
  };
}
