// Transport helpers used by the settings routes.
//
//   node test/http.test.mjs

import assert from 'node:assert';
import { MAX_BODY_BYTES, readJsonBody, sendJson } from '../src/http.js';

/** A response double recording what was written. */
function fakeResponse() {
  const headers = {};
  const res = {
    statusCode: 0,
    body: undefined,
    setHeader(name, value) {
      headers[name] = value;
    },
    end(body) {
      res.body = body;
    },
    headers,
  };
  return res;
}

/** A request double yielding the given chunks. */
async function* chunks(...parts) {
  for (const part of parts) yield Buffer.from(part);
}

// ── replies are JSON, uncached, and never empty ───────────────────────────
{
  const res = fakeResponse();
  sendJson(res, 200, { ok: true, value: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store', 'the payload must not be cached');
  assert.deepEqual(JSON.parse(res.body), { ok: true, value: 1 });
}

// ── a body is parsed, and an empty one becomes an object ──────────────────
{
  assert.deepEqual(await readJsonBody(chunks('{"token":"x"}')), { token: 'x' });
  assert.deepEqual(await readJsonBody(chunks()), {}, 'an empty body is an empty object, not a parse error');
  assert.deepEqual(await readJsonBody(chunks('null')), {}, 'a JSON null is not an object');
  assert.deepEqual(await readJsonBody(chunks('[1,2]')), [1, 2], 'arrays pass through as objects');
}

// ── a body split across chunks is reassembled ─────────────────────────────
{
  const parsed = await readJsonBody(chunks('{"tok', 'en":', '"abc"}'));
  assert.deepEqual(parsed, { token: 'abc' });
}

// ── the size limit is enforced while reading ──────────────────────────────
{
  // Oversized bodies must be rejected without buffering the whole thing.
  const big = 'x'.repeat(MAX_BODY_BYTES);
  await assert.rejects(
    () => readJsonBody(chunks(big, big)),
    /too large/u,
    'a body past the cap is rejected',
  );
}

// ── malformed JSON is an error, not a silent empty object ─────────────────
{
  await assert.rejects(() => readJsonBody(chunks('{oops')), /JSON/u);
}

console.log('http.test.mjs: all assertions passed');
