'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  WithingsApi,
  WithingsError,
  buildSignature,
  normalizeCallbackUrl
} = require('../lib/withings-api');

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';

/**
 * Minimal fetch double. Each entry in `responses` is matched by URL substring
 * and action, and every call is recorded for assertions.
 */
function fakeFetch(handlers) {
  const calls = [];

  const impl = async (url, options) => {
    const params = Object.fromEntries(new URLSearchParams(options.body));
    calls.push({ url, params, headers: options.headers });

    const handler = handlers.find(h =>
      url.includes(h.path) && (!h.action || h.action === params.action));

    if (!handler) throw new Error(`Unexpected call: ${url} ${params.action}`);

    const body = typeof handler.body === 'function' ? handler.body(params) : handler.body;
    return { ok: true, status: 200, json: async () => body };
  };

  impl.calls = calls;
  return impl;
}

const nonceResponse = { path: '/v2/signature', body: { status: 0, body: { nonce: 'abc123' } } };

function tokenResponse(overrides = {}) {
  return {
    path: '/v2/oauth2',
    body: {
      status: 0,
      body: {
        userid: 12345678,
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 10800,
        ...overrides
      }
    }
  };
}

test('buildSignature sorts by parameter name and joins with commas', () => {
  const signature = buildSignature(
    { client_id: CLIENT_ID, action: 'requesttoken', nonce: 'abc123' },
    CLIENT_SECRET
  );

  const expected = crypto
    .createHmac('sha256', CLIENT_SECRET)
    .update(`requesttoken,${CLIENT_ID},abc123`)
    .digest('hex');

  assert.strictEqual(signature, expected);
});

test('buildAuthorizeUrl requests the sleepevents scope and omits state by default', () => {
  const url = new URL(WithingsApi.buildAuthorizeUrl({
    clientId: CLIENT_ID,
    redirectUri: 'https://callback.athom.com/oauth2/callback'
  }));

  assert.strictEqual(url.origin + url.pathname, 'https://account.withings.com/oauth2_user/authorize2');
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.ok(url.searchParams.get('scope').includes('user.sleepevents'));
  assert.strictEqual(url.searchParams.get('state'), null);
});

test('exchangeCode fetches a nonce, signs the request and stores tokens', async () => {
  const fetchImpl = fakeFetch([nonceResponse, tokenResponse()]);
  const stored = [];

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: 'https://callback.athom.com/oauth2/callback',
    onTokens: tokens => stored.push(tokens),
    fetchImpl
  });

  const tokens = await api.exchangeCode('the-code');

  assert.strictEqual(tokens.accessToken, 'access-1');
  assert.strictEqual(tokens.userId, '12345678');
  assert.strictEqual(stored.length, 1);

  const tokenCall = fetchImpl.calls.find(call => call.url.includes('/v2/oauth2'));
  assert.strictEqual(tokenCall.params.grant_type, 'authorization_code');
  assert.strictEqual(tokenCall.params.nonce, 'abc123');
  assert.strictEqual(
    tokenCall.params.signature,
    buildSignature({ action: 'requesttoken', client_id: CLIENT_ID, nonce: 'abc123' }, CLIENT_SECRET)
  );
});

test('verifyCredentials succeeds when Withings hands out a nonce', async () => {
  const fetchImpl = fakeFetch([nonceResponse]);
  const api = new WithingsApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });

  assert.strictEqual(await api.verifyCredentials(), true);

  // The signature is the whole point of the check: a wrong secret produces a
  // wrong HMAC and Withings rejects it.
  const call = fetchImpl.calls.find(c => c.url.includes('/v2/signature'));
  assert.strictEqual(call.params.action, 'getnonce');
  assert.strictEqual(
    call.params.signature,
    buildSignature(
      { action: 'getnonce', client_id: CLIENT_ID, timestamp: call.params.timestamp },
      CLIENT_SECRET
    )
  );
});

test('verifyCredentials surfaces a rejected signature as a WithingsError', async () => {
  const fetchImpl = fakeFetch([
    { path: '/v2/signature', body: { status: 503, error: 'Invalid signature' } }
  ]);
  const api = new WithingsApi({ clientId: CLIENT_ID, clientSecret: 'wrong', fetchImpl });

  await assert.rejects(() => api.verifyCredentials(), err => {
    assert.ok(err instanceof WithingsError);
    assert.strictEqual(err.status, 503);
    return true;
  });
});

test('expiresAt is set a minute before the real deadline', async () => {
  const fetchImpl = fakeFetch([nonceResponse, tokenResponse({ expires_in: 3600 })]);
  const api = new WithingsApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });

  const before = Date.now();
  const tokens = await api.exchangeCode('code');
  const after = Date.now();

  // expiresAt is computed from a clock reading taken somewhere inside the
  // call, so it can only be bounded by the readings either side of it.
  assert.ok(tokens.expiresAt >= before + 3540 * 1000);
  assert.ok(tokens.expiresAt <= after + 3540 * 1000);
});

test('a non-zero status becomes a WithingsError', async () => {
  const fetchImpl = fakeFetch([
    { path: '/v2/signature', body: { status: 503, error: 'Invalid signature' } }
  ]);

  const api = new WithingsApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl });

  await assert.rejects(() => api.exchangeCode('code'), err => {
    assert.ok(err instanceof WithingsError);
    assert.strictEqual(err.status, 503);
    return true;
  });
});

test('concurrent refreshes spend the refresh token only once', async () => {
  const fetchImpl = fakeFetch([nonceResponse, tokenResponse({ access_token: 'access-2' })]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'old', refreshToken: 'refresh-0', expiresAt: 0 },
    fetchImpl
  });

  await Promise.all([api.refresh(), api.refresh(), api.refresh()]);

  const tokenCalls = fetchImpl.calls.filter(call => call.url.includes('/v2/oauth2'));
  assert.strictEqual(tokenCalls.length, 1);
  assert.strictEqual(api.tokens.accessToken, 'access-2');
});

test('an expired access token is refreshed before an authenticated call', async () => {
  const fetchImpl = fakeFetch([
    nonceResponse,
    tokenResponse({ access_token: 'access-fresh' }),
    { path: '/notify', action: 'list', body: { status: 0, body: { profiles: [] } } }
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'stale', refreshToken: 'refresh-0', expiresAt: 0 },
    fetchImpl
  });

  await api.listSubscriptions(50);

  const notifyCall = fetchImpl.calls.find(call => call.url.includes('/notify'));
  assert.strictEqual(notifyCall.headers.Authorization, 'Bearer access-fresh');
});

test('a 401 from the API triggers one refresh and a retry', async () => {
  let notifyCalls = 0;

  const fetchImpl = fakeFetch([
    nonceResponse,
    tokenResponse({ access_token: 'access-retry' }),
    {
      path: '/notify',
      action: 'list',
      body: () => {
        notifyCalls += 1;
        return notifyCalls === 1
          ? { status: 401, error: 'invalid token' }
          : { status: 0, body: { profiles: [] } };
      }
    }
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'stale', refreshToken: 'refresh-0', expiresAt: Date.now() + 3600_000 },
    fetchImpl
  });

  const profiles = await api.listSubscriptions();

  assert.deepStrictEqual(profiles, []);
  assert.strictEqual(notifyCalls, 2);
});

test('normalizeCallbackUrl ignores a trailing slash and parameter order', () => {
  const withSlash = 'https://webhooks.athom.com/webhook/abc123/?homey=xyz';
  const withoutSlash = 'https://webhooks.athom.com/webhook/abc123?homey=xyz';

  assert.strictEqual(normalizeCallbackUrl(withSlash), normalizeCallbackUrl(withoutSlash));

  assert.strictEqual(
    normalizeCallbackUrl('https://host/p?b=2&a=1'),
    normalizeCallbackUrl('https://host/p?a=1&b=2')
  );
});

test('normalizeCallbackUrl still separates genuinely different URLs', () => {
  const mine = normalizeCallbackUrl('https://webhooks.athom.com/webhook/mine/?homey=xyz');

  assert.notStrictEqual(mine, normalizeCallbackUrl('https://webhooks.athom.com/webhook/other/?homey=xyz'));
  assert.notStrictEqual(mine, normalizeCallbackUrl('https://webhooks.athom.com/webhook/mine/?homey=abc'));
  assert.notStrictEqual(mine, normalizeCallbackUrl('https://ifttt.com/webhook/mine/?homey=xyz'));
});

test('normalizeCallbackUrl tolerates junk without throwing', () => {
  assert.strictEqual(normalizeCallbackUrl(''), '');
  assert.strictEqual(normalizeCallbackUrl(null), '');
  assert.strictEqual(normalizeCallbackUrl('not a url/'), 'not a url');
});

test('ensureSubscriptions matches an existing subscription despite a trailing slash', async () => {
  // We send the slashed form; Withings hands it back without the slash.
  const callbackUrl = 'https://webhooks.athom.com/webhook/abc123/?homey=xyz';
  const subscribed = [];

  const fetchImpl = fakeFetch([
    {
      path: '/notify',
      action: 'list',
      body: () => ({
        status: 0,
        body: { profiles: [{ callbackurl: 'https://webhooks.athom.com/webhook/abc123?homey=xyz' }] }
      })
    },
    {
      path: '/notify',
      action: 'subscribe',
      body: params => {
        subscribed.push(Number(params.appli));
        return { status: 0, body: {} };
      }
    }
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'good', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    fetchImpl
  });

  assert.deepStrictEqual(await api.ensureSubscriptions(callbackUrl), []);
  assert.deepStrictEqual(subscribed, []);
});

test('ensureSubscriptions only recreates the categories that are missing', async () => {
  const callbackUrl = 'https://webhooks.athom.com/webhook/abc?homey=xyz';
  const subscribed = [];

  const fetchImpl = fakeFetch([
    {
      path: '/notify',
      action: 'list',
      // appli 50 is alive, appli 51 has silently vanished.
      body: params => ({
        status: 0,
        body: { profiles: Number(params.appli) === 50 ? [{ callbackurl: callbackUrl }] : [] }
      })
    },
    {
      path: '/notify',
      action: 'subscribe',
      body: params => {
        subscribed.push(Number(params.appli));
        return { status: 0, body: {} };
      }
    }
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'good', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    fetchImpl
  });

  const created = await api.ensureSubscriptions(callbackUrl);

  assert.deepStrictEqual(created, [51]);
  assert.deepStrictEqual(subscribed, [51]);
});

test('ensureSubscriptions ignores subscriptions pointing elsewhere', async () => {
  const callbackUrl = 'https://webhooks.athom.com/webhook/mine?homey=xyz';
  const subscribed = [];

  const fetchImpl = fakeFetch([
    {
      path: '/notify',
      action: 'list',
      body: () => ({ status: 0, body: { profiles: [{ callbackurl: 'https://ifttt.com/other' }] } })
    },
    {
      path: '/notify',
      action: 'subscribe',
      body: params => {
        subscribed.push(Number(params.appli));
        return { status: 0, body: {} };
      }
    }
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'good', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    fetchImpl
  });

  assert.deepStrictEqual(await api.ensureSubscriptions(callbackUrl), [50, 51]);
  assert.deepStrictEqual(subscribed, [50, 51]);
});

// --- Transport robustness ---------------------------------------------------

const { isTransientStatus, retryAfterMs, REQUEST_TIMEOUT_MS } = require('../lib/withings-api');

test('only rate limits and server faults are treated as transient', () => {
  assert.strictEqual(isTransientStatus(429), true);
  assert.strictEqual(isTransientStatus(500), true);
  assert.strictEqual(isTransientStatus(503), true);

  // Retrying these would ask the same question and get the same answer.
  assert.strictEqual(isTransientStatus(400), false);
  assert.strictEqual(isTransientStatus(401), false);
  assert.strictEqual(isTransientStatus(403), false);
  assert.strictEqual(isTransientStatus(200), false);
});

test('retryAfterMs reads seconds, dates and nonsense', () => {
  const headers = value => ({ get: () => value });

  assert.strictEqual(retryAfterMs(headers('2')), 2000);
  assert.strictEqual(retryAfterMs(headers(null)), null, 'absent header');
  assert.strictEqual(retryAfterMs(headers('later')), null, 'unparseable');
  assert.strictEqual(retryAfterMs(headers('99999')), 60000, 'capped, not an hour of waiting');
  assert.strictEqual(retryAfterMs(undefined), null);
});

test('a 429 is retried once the advised wait has passed, then succeeds', async () => {
  let calls = 0;
  const waits = [];

  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, headers: { get: () => '3' }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ status: 0, body: { nonce: 'n' } }) };
  };

  const api = new WithingsApi({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
    sleepImpl: async ms => { waits.push(ms); }
  });

  assert.strictEqual(await api.verifyCredentials(), true);
  assert.strictEqual(calls, 2, 'retried exactly once');
  assert.deepStrictEqual(waits, [3000], 'honoured Retry-After rather than the local backoff');
});

test('a persistent server fault gives up instead of hammering', async () => {
  let calls = 0;

  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
  };

  const api = new WithingsApi({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl, sleepImpl: async () => {}
  });

  await assert.rejects(() => api.verifyCredentials(), err => err.status === 503);
  assert.strictEqual(calls, 3, 'three attempts total, not an endless loop');
});

test('a request that never answers is abandoned, not left hanging', async () => {
  // The fetch double respects the abort signal the client passes in.
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

  const api = new WithingsApi({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl,
    timeoutMs: 20, sleepImpl: async () => {}
  });

  await assert.rejects(() => api.verifyCredentials(), err => /timed out/.test(err.message));
});

test('the default timeout is finite', () => {
  assert.ok(Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0);
});

test('a rotated refresh token replaces the old one everywhere at once', async () => {
  const stored = [];
  const fetchImpl = fakeFetch([
    nonceResponse,
    tokenResponse({ access_token: 'access-new', refresh_token: 'refresh-new' })
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 0 },
    onTokens: tokens => stored.push({ ...tokens }),
    fetchImpl
  });

  await api.refresh();

  // Withings invalidates the old refresh token the moment it hands out a new
  // one. Keeping the old one anywhere means the next refresh fails and the
  // user is asked to re-pair for no reason.
  assert.strictEqual(api.tokens.refreshToken, 'refresh-new');
  assert.strictEqual(stored.length, 1, 'persisted exactly once');
  assert.strictEqual(stored[0].refreshToken, 'refresh-new', 'persisted the new one');
  assert.strictEqual(stored[0].accessToken, 'access-new');
});

test('callers waiting on one refresh all continue with the new token', async () => {
  const fetchImpl = fakeFetch([
    nonceResponse,
    tokenResponse({ access_token: 'access-shared', refresh_token: 'refresh-shared' }),
    { path: '/notify', action: 'list', body: { status: 0, body: { profiles: [] } } }
  ]);

  const api = new WithingsApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: 'stale', refreshToken: 'refresh-old', expiresAt: 0 },
    fetchImpl
  });

  await Promise.all([api.listSubscriptions(50), api.listSubscriptions(51)]);

  const tokenCalls = fetchImpl.calls.filter(c => c.url.includes('/v2/oauth2'));
  assert.strictEqual(tokenCalls.length, 1, 'one refresh served both callers');

  for (const call of fetchImpl.calls.filter(c => c.url.includes('/notify'))) {
    assert.strictEqual(call.headers.Authorization, 'Bearer access-shared');
  }
});
