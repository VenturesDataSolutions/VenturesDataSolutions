import { generateReceiptKey, storeReceiptPhoto, storeReceiptPhotoFromBytes } from '../src/receipt-storage.js';
import { createFakeImagesBinding } from './fake-images.js';
import { createFakeR2Bucket } from './fake-r2.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // generateReceiptKey format
  const key = generateReceiptKey('+15559876543');
  assert(/^receipts\/%2B15559876543\/\d+-[0-9a-f-]{36}\.jpg$/.test(key), `generateReceiptKey must produce a receipts/<encoded-number>/<timestamp>-<uuid>.jpg key, got: ${key}`);

  // storeReceiptPhoto: happy path — fetches with Basic Auth, transforms via Images binding, stores to R2
  const mediaBody = { fake: 'stream' };
  const fetchImpl = fakeFetch(true, 200, mediaBody);
  const jpegBytes = new ArrayBuffer(8);
  const imagesBinding = createFakeImagesBinding(jpegBytes);
  const bucket = createFakeR2Bucket();

  const resultKey = await storeReceiptPhoto({
    mediaUrl: 'https://api.twilio.com/media/ME123',
    accountSid: 'AC_test',
    authToken: 'auth_test',
    imagesBinding,
    bucket,
    key: 'receipts/test/123.jpg',
    fetchImpl,
  });

  assert(resultKey === 'receipts/test/123.jpg', 'storeReceiptPhoto must return the key it was given');
  assert(fetchImpl.calls[0].url === 'https://api.twilio.com/media/ME123', 'must fetch the exact Twilio media URL');
  const expectedAuth = `Basic ${Buffer.from('AC_test:auth_test').toString('base64')}`;
  assert(fetchImpl.calls[0].init.headers.Authorization === expectedAuth, 'must send Twilio account SID/auth token as Basic Auth');
  assert(imagesBinding.calls[0].source === mediaBody, 'must pass the fetched media response body into the Images binding');
  assert(imagesBinding.calls[0].transformOptions.width === 1568 && imagesBinding.calls[0].transformOptions.height === 1568, 'must cap both dimensions at 1568px');
  assert(imagesBinding.calls[0].transformOptions.fit === 'scale-down', 'must use scale-down fit so smaller images are never upscaled');
  assert(imagesBinding.calls[0].outputOptions.format === 'image/jpeg' && imagesBinding.calls[0].outputOptions.quality === 85, 'must re-encode as JPEG at quality 85');
  const stored = bucket._store.get('receipts/test/123.jpg');
  assert(stored.value === jpegBytes, 'must store the transformed JPEG bytes in R2 under the given key');
  assert(stored.options.httpMetadata.contentType === 'image/jpeg', 'must set the R2 object content type to image/jpeg');

  // storeReceiptPhoto: Twilio media fetch failure
  const failFetch = fakeFetch(false, 404, null);
  let threw = false;
  try {
    await storeReceiptPhoto({
      mediaUrl: 'https://api.twilio.com/media/ME_missing',
      accountSid: 'AC_test',
      authToken: 'auth_test',
      imagesBinding: createFakeImagesBinding(jpegBytes),
      bucket: createFakeR2Bucket(),
      key: 'receipts/test/456.jpg',
      fetchImpl: failFetch,
    });
  } catch (err) {
    threw = true;
    assert(/404/.test(err.message), 'the error must surface the failed status code');
  }
  assert(threw, 'a failed Twilio media fetch must throw rather than silently store nothing');

  // storeReceiptPhoto: Images binding failure must propagate, not be swallowed
  const throwingImagesBinding = {
    input() {
      return {
        transform() {
          return this;
        },
        async output() {
          throw new Error('Images transform failed: unsupported format');
        },
      };
    },
  };
  let imagesThrew = false;
  try {
    await storeReceiptPhoto({
      mediaUrl: 'https://api.twilio.com/media/ME789',
      accountSid: 'AC_test',
      authToken: 'auth_test',
      imagesBinding: throwingImagesBinding,
      bucket: createFakeR2Bucket(),
      key: 'receipts/test/789.jpg',
      fetchImpl: fakeFetch(true, 200, mediaBody),
    });
  } catch (err) {
    imagesThrew = true;
    assert(/Images transform failed/.test(err.message), 'the Images binding error must propagate unchanged');
  }
  assert(imagesThrew, 'an Images binding failure must throw rather than silently storing nothing (so Twilio retries)');

  // storeReceiptPhoto: R2 put() failure must propagate, not be swallowed
  const throwingBucket = {
    async put() {
      throw new Error('R2 put failed: bucket unavailable');
    },
  };
  let r2Threw = false;
  try {
    await storeReceiptPhoto({
      mediaUrl: 'https://api.twilio.com/media/ME999',
      accountSid: 'AC_test',
      authToken: 'auth_test',
      imagesBinding: createFakeImagesBinding(jpegBytes),
      bucket: throwingBucket,
      key: 'receipts/test/999.jpg',
      fetchImpl: fakeFetch(true, 200, mediaBody),
    });
  } catch (err) {
    r2Threw = true;
    assert(/R2 put failed/.test(err.message), 'the R2 put() error must propagate unchanged');
  }
  assert(r2Threw, 'an R2 put() failure must throw rather than silently succeeding (so Twilio retries)');

  // storeReceiptPhotoFromBytes: happy path — no fetch, transforms via Images binding, stores to R2
  {
    const inputBytes = new Uint8Array([9, 9, 9]);
    const jpegBytes2 = new ArrayBuffer(4);
    const imagesBinding = createFakeImagesBinding(jpegBytes2);
    const bucket = createFakeR2Bucket();
    const resultKey = await storeReceiptPhotoFromBytes({
      bytes: inputBytes,
      imagesBinding,
      bucket,
      key: 'receipts/email/1.jpg',
    });
    assert(resultKey === 'receipts/email/1.jpg', 'storeReceiptPhotoFromBytes must return the key it was given');
    assert(imagesBinding.calls[0].source instanceof ReadableStream, 'must pass a ReadableStream into the Images binding (confirmed against the real binding: it does not accept a raw Uint8Array/ArrayBuffer directly)');
    const streamedBytes = new Uint8Array(await new Response(imagesBinding.calls[0].source).arrayBuffer());
    assert(streamedBytes.length === inputBytes.length && streamedBytes.every((b, i) => b === inputBytes[i]), 'the streamed bytes must round-trip to exactly the given bytes, with no fetch involved');
    assert(imagesBinding.calls[0].transformOptions.width === 1568 && imagesBinding.calls[0].transformOptions.height === 1568, 'must cap both dimensions at 1568px, same as the SMS path');
    assert(imagesBinding.calls[0].outputOptions.format === 'image/jpeg' && imagesBinding.calls[0].outputOptions.quality === 85, 'must re-encode as JPEG at quality 85, same as the SMS path');
    const stored = bucket._store.get('receipts/email/1.jpg');
    assert(stored.value === jpegBytes2, 'must store the transformed JPEG bytes in R2 under the given key');
    assert(stored.options.httpMetadata.contentType === 'image/jpeg', 'must set the R2 object content type to image/jpeg');
  }

  // storeReceiptPhotoFromBytes: Images binding failure must propagate, not be swallowed
  {
    const throwingImagesBinding = {
      input() {
        return { transform() { return this; }, async output() { throw new Error('Images transform failed: unsupported format'); } };
      },
    };
    let threw = false;
    try {
      await storeReceiptPhotoFromBytes({ bytes: new Uint8Array([1]), imagesBinding: throwingImagesBinding, bucket: createFakeR2Bucket(), key: 'receipts/email/2.jpg' });
    } catch (err) {
      threw = true;
      assert(/Images transform failed/.test(err.message), 'the Images binding error must propagate unchanged');
    }
    assert(threw, 'an Images binding failure must throw rather than silently storing nothing');
  }

  console.log('PASS: receipt-storage.test.js');
}

await main();
