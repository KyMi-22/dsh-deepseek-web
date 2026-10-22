// Retry-stage markers: which failures may be retried without risking a duplicate.
//
// The adapter keeps a per-message dedup memo so one turn cannot ask the web model
// twice. Its decision to release that memo rests on `error.submitted`, which must
// be exactly right in both directions:
//
//   - clearing it when the request may have reached the server → the same prompt is
//     posted twice and the user gets two answers;
//   - failing to clear it when nothing was sent → the retry is swallowed and the
//     turn ends with an empty reply.
//
//   node test/retry-marker.test.mjs

import assert from 'node:assert';
import { DeepSeekWebApi, DeepSeekWebError } from '../src/api.js';
import { DeepSeekHash } from '../src/pow.js';

// A challenge whose answer is 0 by construction, so the solve always succeeds and
// the tests can reach the stage they actually care about.
const SALT = 'salt';
const EXPIRE_AT = 1700000000000;
const CHALLENGE = {
  algorithm: 'DeepSeekHashV1',
  challenge: new DeepSeekHash().writeAscii(`${SALT}_${EXPIRE_AT}_`).writeAscii('0').digestHex(),
  salt: SALT,
  signature: 'sig',
  difficulty: 8,
  expire_at: EXPIRE_AT,
  target_path: '/api/v0/chat/completion',
};

/** A fake fetch that answers the challenge endpoint and then honours `onCompletion`. */
function fakeFetch(onCompletion) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('create_pow_challenge')) {
      // `request()` reads the body with text() and parses it itself, so the fake
      // must answer there rather than only via json().
      const payload = JSON.stringify({ data: { biz_data: { challenge: CHALLENGE } } });
      return {
        ok: true,
        status: 200,
        text: async () => payload,
        json: async () => JSON.parse(payload),
      };
    }
    return onCompletion(url, init);
  };
  return { impl, calls };
}

/** Drain the generator, returning the error it threw. */
async function capture(api) {
  try {
    for await (const _event of api.streamCompletion({
      chatSessionId: 'web-1',
      prompt: 'hi',
      thinking: false,
      search: false,
    })) {
      /* drain */
    }
  } catch (error) {
    return error;
  }
  return null;
}

// ── a failure before the POST is marked retryable ─────────────────────────
{
  // The challenge request itself fails. Nothing reached the model, so the adapter
  // must be allowed to retry — and this must hold for a plain TypeError too, not
  // only for DeepSeekWebError.
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    fetchImpl: async () => {
      // Malformed envelope: unwrap throws a DeepSeekWebError, and the marker is
      // applied on the way out of solveChallenge.
      throw new TypeError('socket hang up');
    },
  });
  const error = await capture(api);
  assert.ok(error !== null, 'the call failed');
  assert.equal(error.submitted, false, 'a pre-POST TypeError is marked retryable');
}

// ── a completion fetch rejection is UNKNOWN, not retryable ────────────────
{
  // The socket died while the POST was in flight. The server may have received it
  // and started generating; a retry could produce two answers to one message.
  const { impl } = fakeFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const api = new DeepSeekWebApi({ token: 'fake-token', fetchImpl: impl });
  const error = await capture(api);
  assert.ok(error !== null, 'the call failed');
  assert.equal(error.submitted, undefined, 'an in-flight failure is not marked retryable');
}

// ── an HTTP rejection IS submitted ────────────────────────────────────────
{
  const { impl } = fakeFetch(async () => ({
    ok: false,
    status: 500,
    text: async () => 'boom',
    json: async () => ({}),
  }));
  const api = new DeepSeekWebApi({ token: 'fake-token', fetchImpl: impl });
  const error = await capture(api);
  assert.ok(error instanceof DeepSeekWebError);
  assert.equal(error.submitted, true, 'the server answered, so the prompt may have been consumed');
}

// ── a frozen error object cannot be marked, which safely means "unknown" ──
{
  const frozen = Object.freeze(new TypeError('frozen'));
  const api = new DeepSeekWebApi({
    token: 'fake-token',
    fetchImpl: async () => {
      throw frozen;
    },
  });
  const error = await capture(api);
  assert.equal(error, frozen, 'the original error is rethrown');
  assert.equal(error.submitted, undefined, 'a frozen error keeps the conservative default');
}

console.log('retry-marker.test.mjs: all assertions passed');
