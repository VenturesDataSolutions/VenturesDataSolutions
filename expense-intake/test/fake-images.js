// expense-intake/test/fake-images.js
// Mimics the shape of the real Cloudflare Images Workers binding (env.IMAGES) closely enough
// to test the calling code's wiring, without needing the real binding (which has no local
// emulation — see Step 3's Design decisions note in the plan).
export function createFakeImagesBinding(outputBytes) {
  const calls = [];
  return {
    input(source) {
      const call = { source, transformOptions: null, outputOptions: null };
      calls.push(call);
      const chain = {
        transform(options) {
          call.transformOptions = options;
          return chain;
        },
        async output(options) {
          call.outputOptions = options;
          return {
            response() {
              return { arrayBuffer: async () => outputBytes };
            },
          };
        },
      };
      return chain;
    },
    calls,
  };
}
