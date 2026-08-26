// expense-intake/test/fake-email-send.js
export function createFakeEmailSender() {
  const calls = [];
  return {
    async send(options) {
      calls.push(options);
      return { id: `fake-email-${calls.length}` };
    },
    calls,
  };
}
