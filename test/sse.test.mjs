// SSE framing tests: the parser must survive CRLF, chunk splits, and odd endings.
//
//   node test/sse.test.mjs

import assert from 'node:assert';
import { readSse } from '../src/api.js';

/** Feed raw byte chunks through readSse and collect the events. */
async function collect(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSse(stream)) events.push(event);
  return events;
}

// ── plain LF framing ───────────────────────────────────────────────────────
{
  const events = await collect(['data: {"a":1}\n\ndata: {"a":2}\n\n']);
  assert.deepEqual(events.map((e) => e.data), [{ a: 1 }, { a: 2 }], 'LF-separated records are split');
  assert.deepEqual(events.map((e) => e.type), ['message', 'message']);
}

// ── CRLF framing: this is the regression the review found ─────────────────
{
  const events = await collect(['data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n']);
  assert.equal(events.length, 2, 'CRLF-separated records must not be merged into one');
  assert.deepEqual(events.map((e) => e.data), [{ a: 1 }, { a: 2 }], 'CRLF records parse individually');
}

// ── a CRLF pair split across two chunks ───────────────────────────────────
{
  const events = await collect(['data: {"a":1}\r', '\n\r', '\ndata: {"a":2}\r\n\r\n']);
  assert.deepEqual(events.map((e) => e.data), [{ a: 1 }, { a: 2 }], 'a split \\r\\n boundary is handled');
}

// ── event type and multi-line data ────────────────────────────────────────
{
  const events = await collect(['event: ready\ndata: {"x":\ndata: 42}\n\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ready', 'the event name is carried through');
  assert.deepEqual(events[0].data, { x: 42 }, 'multi-line data is joined before parsing');
}

// ── unparsable payload becomes null, not a dropped event ──────────────────
{
  const events = await collect(['data: not-json\n\n']);
  assert.equal(events.length, 1, 'a malformed record still yields an event');
  assert.equal(events[0].data, null, 'malformed JSON surfaces as null');
}

// ── trailing record without its blank line ────────────────────────────────
{
  const events = await collect(['data: {"a":1}']);
  assert.deepEqual(events.map((e) => e.data), [{ a: 1 }], 'an unterminated final record is still emitted');
}

// ── comments and unknown fields are ignored ───────────────────────────────
{
  const events = await collect([': keep-alive\n\nid: 7\nretry: 100\ndata: {"a":1}\n\n']);
  assert.deepEqual(events.map((e) => e.data), [{ a: 1 }], 'comments and unrelated fields are skipped');
}

// ── an empty stream yields nothing ────────────────────────────────────────
{
  assert.deepEqual(await collect([]), [], 'an empty body produces no events');
  assert.deepEqual(await collect(['\n\n']), [], 'blank blocks produce no events');
}

// ── a stalled stream trips the idle guard instead of hanging ──────────────
{
  // A server that accepts the request and then says nothing would otherwise hold
  // the caller (and, through it, the serialized sync pass) indefinitely.
  const stalled = new ReadableStream({ start() { /* never enqueues */ } });
  const iterator = readSse(stalled, undefined, 50);
  await assert.rejects(() => iterator.next(), /idle/u, 'an idle stream is abandoned rather than awaited forever');
}

console.log('sse.test.mjs: all assertions passed');
