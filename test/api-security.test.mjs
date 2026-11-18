/**
 * Browser-shape headers, HIF token caching, and risk-control error mapping.
 *
 *   node test/api-security.test.mjs
 */

import assert from 'node:assert';
import { DeepSeekWebApi, DeepSeekWebError } from '../src/api.js';

/** A minimal Fetch Response double. */
function reply(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const DEVICE = '11111111-1111-4111-8111-111111111111';

// ── browser-shape headers and HIF cache ───────────────────────────────────
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (String(url).includes('hif-leim')) return reply(200, { data: { biz_data: { value: 'leim-token' } } }, { 'x-hif-ttl': '600' });
    if (String(url).includes('hif-dliq')) return reply(200, { data: { biz_data: { value: 'dliq-token' } } }, { 'x-hif-ttl': '600' });
    if (String(url).includes('fetch_page')) {
      return reply(200, { code: 0, data: { biz_code: 0, biz_data: { chat_sessions: [], has_more: false } } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    deviceId: DEVICE,
    fetchImpl,
    hif: true,
    requestGapMs: 0,
    locale: 'zh-CN',
  });
  await api.listSessions();
  await api.listSessions();

  const apiCall = calls.find((call) => call.url.includes('fetch_page'));
  assert.equal(calls.filter((call) => call.url.includes('hif-leim')).length, 1, 'HIF leim is fetched once and cached');
  assert.equal(calls.filter((call) => call.url.includes('hif-dliq')).length, 1, 'HIF dliq is fetched once and cached');
  assert.equal(apiCall.headers['x-client-version'], '2.8.0', 'the current web client version is advertised');
  assert.equal(apiCall.headers['x-client-bundle-id'], 'com.deepseek.chat');
  assert.equal(apiCall.headers['x-client-locale'], 'zh_CN', 'the configured locale is normalized for the web client');
  assert.equal(apiCall.headers['x-device-id'], DEVICE);
  assert.equal(apiCall.headers['x-hif-leim'], 'leim-token');
  assert.equal(apiCall.headers['x-hif-dliq'], 'dliq-token');
  assert.ok(String(apiCall.headers['User-Agent']).includes('Chrome/'), 'a browser User-Agent is sent');
  assert.equal(
    apiCall.headers['x-client-timezone-offset'],
    String(-new Date().getTimezoneOffset() * 60),
    'the local timezone offset is sent',
  );
}

// ── a WAF captcha/challenge is typed and never auto-retried ───────────────
{
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    deviceId: DEVICE,
    requestGapMs: 0,
    hif: false,
    fetchImpl: async () => reply(405, { code: 1 }, { 'x-amzn-waf-action': 'captcha' }),
  });
  await assert.rejects(
    () => api.currentUser(),
    (error) => {
      assert.equal(error instanceof DeepSeekWebError, true);
      assert.equal(error.code, 'CHALLENGE_REQUIRED');
      assert.equal(error.submitted, false);
      assert.ok(error.message.includes('人机验证'));
      return true;
    },
  );
}

// ── a 429 becomes RATE_LIMITED and a pacing header is recorded ────────────
{
  let calls = 0;
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    deviceId: DEVICE,
    requestGapMs: 0,
    hif: false,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? reply(200, { code: 0, data: { biz_code: 0, biz_data: {} } }, { 'x-fetch-after-sec': '1' })
        : reply(429, { code: 1 });
    },
  });
  await api.currentUser();
  assert.ok(api.nextRequestAt > Date.now(), 'the pacing header postpones the next request');
  assert.equal(api.rateLimitSeconds, 1);
  await assert.rejects(
    () => api.currentUser(),
    (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.submitted, false);
      return true;
    },
  );
}

// ── a 429 is rate-limited even when the body is HTML ──────────────────────
{
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    deviceId: DEVICE,
    requestGapMs: 0,
    hif: false,
    fetchImpl: async () => reply(429, '<html>Too Many Requests</html>'),
  });
  await assert.rejects(
    () => api.currentUser(),
    (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.submitted, false);
      return true;
    },
  );
}

// ── authRejected tracks 401 and is cleared by a new token ────────────────
{
  let authorized = false;
  const api = new DeepSeekWebApi({
    token: 'old',
    deviceId: DEVICE,
    requestGapMs: 0,
    hif: false,
    fetchImpl: async () => authorized
      ? reply(200, { code: 0, data: { biz_code: 0, biz_data: {} } })
      : reply(401, { code: 401001 }),
  });
  await assert.rejects(() => api.currentUser(), (error) => error.code === 'UNAUTHORIZED');
  assert.equal(api.authRejected, true);
  authorized = true;
  await api.currentUser();
  assert.equal(api.authRejected, false, 'a successful call clears the rejection');
  api.authRejected = true;
  api.configure({ token: 'new' });
  assert.equal(api.authRejected, false, 'saving a new token clears the rejection');
}

// ── an explicit hif:false makes no HIF calls ──────────────────────────────
{
  const calls = [];
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    deviceId: DEVICE,
    hif: false,
    requestGapMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return reply(200, { code: 0, data: { biz_code: 0, biz_data: {} } });
    },
  });
  await api.currentUser();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('users/current'));
}

console.log('api-security.test.mjs: all assertions passed');
