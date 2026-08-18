// expense-intake/test/twilio.test.js
import crypto from 'node:crypto';
import { parseFormBody, verifyTwilioSignature, extractWebhookFields, sendSms } from '../src/twilio.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

function fakeFetch(ok, status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

function computeExpectedSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let stringToSign = url;
  for (const key of sortedKeys) {
    stringToSign += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(stringToSign).digest('base64');
}

async function main() {
  // parseFormBody
  const params = parseFormBody('From=%2B15551234567&To=%2B15559876543&Body=Home+Depot+%2442.50&NumMedia=1&MediaUrl0=https%3A%2F%2Fapi.twilio.com%2Fmedia%2FME123');
  assert(params.From === '+15551234567', 'parseFormBody must URL-decode field values');
  assert(params.Body === 'Home Depot $42.50', 'parseFormBody must decode + as space');
  assert(params.NumMedia === '1', 'parseFormBody must expose NumMedia as a string field');

  // verifyTwilioSignature: valid signature
  const url = 'https://expense-intake.example.com/sms';
  const authToken = 'test_auth_token';
  const goodParams = { From: '+15551234567', To: '+15559876543', Body: 'Home Depot $42.50' };
  const validSig = computeExpectedSignature(url, goodParams, authToken);
  const validResult = await verifyTwilioSignature({ url, params: goodParams, signature: validSig, authToken });
  assert(validResult === true, 'a correctly computed signature must verify as valid');

  // verifyTwilioSignature: tampered signature
  const tamperedResult = await verifyTwilioSignature({ url, params: goodParams, signature: 'not-the-real-signature==', authToken });
  assert(tamperedResult === false, 'a tampered/incorrect signature must not verify');

  // verifyTwilioSignature: tampered params (same signature, different body)
  const tamperedParams = { ...goodParams, Body: 'Home Depot $999.99' };
  const tamperedParamsResult = await verifyTwilioSignature({ url, params: tamperedParams, signature: validSig, authToken });
  assert(tamperedParamsResult === false, 'a signature computed for different params must not verify against altered params');

  // verifyTwilioSignature: missing signature or authToken
  assert((await verifyTwilioSignature({ url, params: goodParams, signature: '', authToken })) === false, 'an empty signature must not verify');
  assert((await verifyTwilioSignature({ url, params: goodParams, signature: validSig, authToken: '' })) === false, 'a missing authToken must not verify');

  // extractWebhookFields: text-only message
  const textOnly = extractWebhookFields({ From: '+15551234567', To: '+15559876543', Body: 'Home Depot $42.50', NumMedia: '0' });
  assert(textOnly.from === '+15551234567' && textOnly.to === '+15559876543' && textOnly.body === 'Home Depot $42.50', 'extractWebhookFields must extract From/To/Body');
  assert(textOnly.media.length === 0, 'a text-only message must have an empty media array');

  // extractWebhookFields: message with one photo
  const withPhoto = extractWebhookFields({
    From: '+15551234567', To: '+15559876543', Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/ME123', MediaContentType0: 'image/jpeg',
  });
  assert(withPhoto.media.length === 1, 'a message with NumMedia=1 must produce one media entry');
  assert(withPhoto.media[0].url === 'https://api.twilio.com/media/ME123' && withPhoto.media[0].contentType === 'image/jpeg', 'the media entry must carry the URL and content type');

  // extractWebhookFields: NumMedia present but the indexed field is missing (defensive)
  const malformed = extractWebhookFields({ From: '+1', To: '+2', Body: '', NumMedia: '2', MediaUrl0: 'https://api.twilio.com/media/ME1', MediaContentType0: 'image/jpeg' });
  assert(malformed.media.length === 1, 'a missing MediaUrl at a given index must be skipped rather than producing a broken entry');

  // extractWebhookFields: NumMedia with an absurdly large value must not cause unbounded iteration
  const oversized = extractWebhookFields({ From: '+1', To: '+2', Body: '', NumMedia: '999999' });
  assert(oversized.media.length <= 10, 'an oversized NumMedia value must be capped rather than driving unbounded iteration over MediaUrlN fields');

  // extractWebhookFields: messageSid is extracted for dedup purposes
  const withSid = extractWebhookFields({
    From: '+15551234567', To: '+15559876543', Body: 'hi', NumMedia: '0', MessageSid: 'SM1234567890abcdef',
  });
  assert(withSid.messageSid === 'SM1234567890abcdef', 'extractWebhookFields must expose MessageSid as messageSid');

  // extractWebhookFields: missing MessageSid defaults to an empty string, not undefined
  const noSid = extractWebhookFields({ From: '+1', To: '+2', Body: 'hi', NumMedia: '0' });
  assert(noSid.messageSid === '', 'a missing MessageSid must default to an empty string');

  // sendSms
  const sendFetch = fakeFetch(true, 201, { sid: 'SM123', status: 'queued' });
  const sendResult = await sendSms({ accountSid: 'AC_test', authToken: 'test_auth_token', from: '+15559876543', to: '+15551234567', body: 'Test message', fetchImpl: sendFetch });
  assert(sendResult.sid === 'SM123', 'sendSms must return the parsed Twilio API response');
  const sendCall = sendFetch.calls[0];
  assert(sendCall.url === 'https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json', 'sendSms must hit the Twilio Messages resource for the given accountSid');
  assert(sendCall.init.headers.Authorization === `Basic ${Buffer.from('AC_test:test_auth_token').toString('base64')}`, 'sendSms must send Basic Auth using accountSid:authToken');
  const sendBody = new URLSearchParams(sendCall.init.body);
  assert(sendBody.get('To') === '+15551234567' && sendBody.get('From') === '+15559876543' && sendBody.get('Body') === 'Test message', 'sendSms must form-encode To/From/Body');

  // sendSms: error path
  const failFetch = fakeFetch(false, 400, { code: 21211, message: 'Invalid To Phone Number' });
  let threwSend = false;
  try {
    await sendSms({ accountSid: 'AC_test', authToken: 'test_auth_token', from: '+15559876543', to: 'bad', body: 'x', fetchImpl: failFetch });
  } catch (err) {
    threwSend = true;
    assert(err.message === 'Invalid To Phone Number', 'sendSms must surface the Twilio API error message');
  }
  assert(threwSend, 'a non-2xx Twilio response must throw');

  console.log('PASS: twilio.test.js');
}

await main();
