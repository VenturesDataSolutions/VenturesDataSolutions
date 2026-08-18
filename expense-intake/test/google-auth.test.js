// expense-intake/test/google-auth.test.js
import crypto from 'node:crypto';
import { getGoogleAccessToken, SHEETS_SCOPE, DRIVE_FILE_SCOPE } from '../src/google-auth.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function generateTestServiceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    serviceAccount: { client_email: 'test-sa@test-project.iam.gserviceaccount.com', private_key: privateKey },
    publicKey,
  };
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  const { serviceAccount, publicKey } = generateTestServiceAccount();

  // happy path: builds and signs a real JWT, exchanges it, returns the access token
  const fetchImpl = fakeFetch(true, 200, { access_token: 'ya29.fake_token', token_type: 'Bearer', expires_in: 3600 });
  const token = await getGoogleAccessToken({ serviceAccountJson: serviceAccount, fetchImpl, now: () => 1735689600000 });
  assert(token === 'ya29.fake_token', 'getGoogleAccessToken must return the access_token from the response');

  const call = fetchImpl.calls[0];
  assert(call.url === 'https://oauth2.googleapis.com/token', 'must POST to the Google token endpoint');
  const bodyParams = new URLSearchParams(call.init.body);
  assert(bodyParams.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'must use the JWT bearer grant type');
  const jwt = bodyParams.get('assertion');
  assert(jwt, 'must send a signed JWT as the assertion parameter');

  // the JWT must actually verify against the service account's real public key —
  // this is the thing that would catch a broken signing implementation
  const [encodedHeader, encodedClaimSet, encodedSignature] = jwt.split('.');
  const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
  const claimSet = JSON.parse(base64UrlDecode(encodedClaimSet).toString('utf8'));
  assert(header.alg === 'RS256', 'JWT header must specify RS256');
  assert(claimSet.iss === 'test-sa@test-project.iam.gserviceaccount.com', 'JWT claim set must carry the service account email as iss');
  assert(claimSet.scope === 'https://www.googleapis.com/auth/spreadsheets', 'JWT claim set must request the Sheets scope');
  assert(claimSet.aud === 'https://oauth2.googleapis.com/token', 'JWT claim set aud must be the token endpoint');
  assert(claimSet.exp === claimSet.iat + 3600, 'JWT must expire exactly 1 hour after issuance');
  assert(claimSet.iat === 1735689600, 'iat must come from the injected now()');

  const signingInput = `${encodedHeader}.${encodedClaimSet}`;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signingInput);
  const signatureValid = verifier.verify(publicKey, base64UrlDecode(encodedSignature));
  assert(signatureValid, "the JWT signature must verify against the service account's real public key");

  // negative control: verification must actually reject a signature made with a different key —
  // proves the verification harness above isn't trivially permissive
  const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const wrongKeyVerifier = crypto.createVerify('RSA-SHA256');
  wrongKeyVerifier.update(signingInput);
  const signatureValidWithWrongKey = wrongKeyVerifier.verify(wrongPublicKey, base64UrlDecode(encodedSignature));
  assert(!signatureValidWithWrongKey, 'signature verification must reject a signature checked against the wrong public key');

  // error path: Google rejects the token request
  const failFetch = fakeFetch(false, 400, { error: 'invalid_grant', error_description: 'Invalid JWT signature' });
  let threw = false;
  try {
    await getGoogleAccessToken({ serviceAccountJson: serviceAccount, fetchImpl: failFetch });
  } catch (err) {
    threw = true;
    assert(err.message === 'Invalid JWT signature', "must surface Google's error_description");
  }
  assert(threw, 'a non-2xx token response must throw');

  // accepts a JSON string for serviceAccountJson too (as it would come from an env secret)
  const stringFetch = fakeFetch(true, 200, { access_token: 'ya29.from_string', token_type: 'Bearer', expires_in: 3600 });
  const tokenFromString = await getGoogleAccessToken({ serviceAccountJson: JSON.stringify(serviceAccount), fetchImpl: stringFetch });
  assert(tokenFromString === 'ya29.from_string', 'must accept serviceAccountJson as a raw JSON string (as stored in a Worker secret)');

  // an explicit scope param overrides the default SHEETS_SCOPE (used by the onboarding
  // script, which additionally needs Drive access to share a newly created Sheet)
  const scopeFetch = fakeFetch(true, 200, { access_token: 'ya29.scoped_token', token_type: 'Bearer', expires_in: 3600 });
  await getGoogleAccessToken({
    serviceAccountJson: serviceAccount, fetchImpl: scopeFetch,
    scope: `${SHEETS_SCOPE} ${DRIVE_FILE_SCOPE}`,
  });
  const scopeJwt = new URLSearchParams(scopeFetch.calls[0].init.body).get('assertion');
  const [, encodedScopeClaimSet] = scopeJwt.split('.');
  const scopeClaimSet = JSON.parse(base64UrlDecode(encodedScopeClaimSet).toString('utf8'));
  assert(scopeClaimSet.scope === 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file', 'a provided scope must override the default and support space-joined multiple scopes');

  console.log('PASS: google-auth.test.js');
}

await main();
