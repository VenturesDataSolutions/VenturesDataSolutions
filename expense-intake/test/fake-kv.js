// expense-intake/test/fake-kv.js
// Mirrors worker/test/fake-kv.js's shape, plus call recording (matching this project's
// fake-r2.js/fake-images.js convention) so tests can assert on put() options like expirationTtl.
export function createFakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  return {
    async get(key, options) {
      calls.push({ method: 'get', key, options });
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (options && options.type === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    },
    async put(key, value, options) {
      calls.push({ method: 'put', key, value, options });
      store.set(key, value);
    },
    async delete(key) {
      calls.push({ method: 'delete', key });
      store.delete(key);
    },
    _store: store,
    calls,
  };
}
