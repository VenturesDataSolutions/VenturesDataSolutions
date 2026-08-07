// worker/test/fake-kv.js
export function createFakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key, options) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (options && options.type === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    _store: store,
  };
}
