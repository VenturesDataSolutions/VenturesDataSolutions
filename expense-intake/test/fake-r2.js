// expense-intake/test/fake-r2.js
export function createFakeR2Bucket() {
  const store = new Map();
  return {
    async put(key, value, options) {
      store.set(key, { value, options });
    },
    async get(key) {
      if (!store.has(key)) return null;
      const { value, options } = store.get(key);
      return {
        arrayBuffer: async () => value,
        httpMetadata: options && options.httpMetadata,
      };
    },
    _store: store,
  };
}
