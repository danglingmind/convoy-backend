import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, deliver, hostOrder, shouldRefreshJwt, ApnsAnswer, ApnsEnv } from '../src/services/notifications/apnsRouting';

const ok: ApnsAnswer = { status: 200, text: '' };
const badToken: ApnsAnswer = { status: 400, text: '{"reason":"BadDeviceToken"}' };
const gone: ApnsAnswer = { status: 410, text: '{"reason":"Unregistered"}' };

test('classify', () => {
  assert.equal(classify(ok), 'sent');
  assert.equal(classify(gone), 'dead');
  assert.equal(classify(badToken), 'wrong-env');
  assert.equal(classify({ status: 403, text: '{"reason":"BadEnvironmentKeyInToken"}' }), 'error');
  assert.equal(classify({ status: 429, text: '{"reason":"TooManyProviderTokenUpdates"}' }), 'error');
});

test('hostOrder: production first by default, sandbox first only when configured, known env wins', () => {
  assert.deepEqual(hostOrder(undefined), ['production', 'sandbox']);
  assert.deepEqual(hostOrder('production'), ['production', 'sandbox']);
  assert.deepEqual(hostOrder('sandbox'), ['sandbox', 'production']);
  assert.deepEqual(hostOrder(undefined, 'sandbox'), ['sandbox', 'production']);
});

test('production token: answered on the first host, no retry', async () => {
  const calls: ApnsEnv[] = [];
  const r = await deliver(['production', 'sandbox'], async (env) => { calls.push(env); return ok; });
  assert.deepEqual(calls, ['production']);
  assert.equal(r.outcome, 'sent');
  assert.equal(r.env, 'production');
});

test('sandbox token: production says BadDeviceToken, sandbox delivers', async () => {
  const calls: ApnsEnv[] = [];
  const r = await deliver(['production', 'sandbox'], async (env) => {
    calls.push(env);
    return env === 'production' ? badToken : ok;
  });
  assert.deepEqual(calls, ['production', 'sandbox']);
  assert.equal(r.outcome, 'sent');
  assert.equal(r.env, 'sandbox');
});

test('BadDeviceToken on both hosts is not "dead": the token must not be removed', async () => {
  const r = await deliver(['production', 'sandbox'], async () => badToken);
  assert.equal(r.outcome, 'wrong-env');
  assert.equal(r.env, null);
});

test('410 Unregistered on the first host is final (token removed, no retry)', async () => {
  const calls: ApnsEnv[] = [];
  const r = await deliver(['production', 'sandbox'], async (env) => { calls.push(env); return gone; });
  assert.deepEqual(calls, ['production']);
  assert.equal(r.outcome, 'dead');
});

test('other errors do not fall through to the second host', async () => {
  const calls: ApnsEnv[] = [];
  const r = await deliver(['production', 'sandbox'], async (env) => {
    calls.push(env);
    return { status: 500, text: '{"reason":"InternalServerError"}' };
  });
  assert.deepEqual(calls, ['production']);
  assert.equal(r.outcome, 'error');
});

test('JWT refresh only for expired/invalid provider tokens, and not within 20 minutes', () => {
  const expired = { status: 403, text: '{"reason":"ExpiredProviderToken"}' };
  assert.equal(shouldRefreshJwt(expired, 41 * 60_000), true);
  assert.equal(shouldRefreshJwt(expired, 5 * 60_000), false);
  assert.equal(shouldRefreshJwt({ status: 403, text: '{"reason":"BadEnvironmentKeyInToken"}' }, 41 * 60_000), false);
  assert.equal(shouldRefreshJwt({ status: 429, text: '{"reason":"TooManyProviderTokenUpdates"}' }, 41 * 60_000), false);
});
