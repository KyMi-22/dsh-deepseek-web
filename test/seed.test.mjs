// Structural test for the web-history -> session-event conversion.
//
// Runs offline on a hand-written sample shaped like a real `history_messages`
// reply. It pins the event vocabulary a live loop produces, because the
// transcript projection, the session title, and the request epoch are all
// derived from those events: drop `step/start` and the assistant message never
// renders, drop `session/title` and the sidebar row is blank, drop
// `request/header` and a resumed session has no provider route.
//
//   node test/seed.test.mjs

import assert from 'node:assert';
import { buildSeedEvents, lastMessageId } from '../src/sync.js';

const META = { title: '打招呼与追问', provider: 'deepseek-web', model: 'deepseek-web-chat' };

/** Two exchanges, mirroring the shape the web endpoint returns. */
const messages = [
  {
    message_id: 1,
    parent_id: null,
    role: 'USER',
    inserted_at: 1792592849.267,
    fragments: [{ id: 1, type: 'REQUEST', content: '你好' }],
  },
  {
    message_id: 2,
    parent_id: 1,
    role: 'ASSISTANT',
    inserted_at: 1792592849.264,
    fragments: [
      { id: 2, type: 'THINK', content: '用户在打招呼。' },
      { id: 3, type: 'RESPONSE', content: '你好！' },
    ],
  },
  {
    message_id: 3,
    parent_id: 2,
    role: 'USER',
    inserted_at: 1792592900,
    fragments: [{ id: 4, type: 'REQUEST', content: '再问一句' }],
  },
  {
    message_id: 4,
    parent_id: 3,
    role: 'ASSISTANT',
    inserted_at: 1792592901,
    fragments: [{ id: 5, type: 'RESPONSE', content: '好的。' }],
  },
];

assert.equal(lastMessageId(messages), 4);

const events = buildSeedEvents(messages, META);
console.log('events:', events.map((e) => `${e.seq}:${e.type}`).join(' '));

// Dense, ordered sequence numbers.
for (let i = 0; i < events.length; i++) assert.equal(events[i].seq, i, 'seq is dense and ordered');

// Every turn opens and closes; turns and steps are 1-based like the loop.
const opens = events.filter((e) => e.type === 'turn/start');
const closes = events.filter((e) => e.type === 'turn/end').length;
assert.equal(opens.length, closes, 'every turn closes');
assert.equal(opens.length, 2, 'two exchanges make two turns');
assert.deepEqual(opens.map((e) => e.data.turn), [1, 2], 'turns are 1-based and contiguous');

// Each open turn is paired with one step, and the step closes inside the turn.
let openTurn = null;
let openStep = null;
for (const event of events) {
  if (event.type === 'turn/start') {
    openTurn = event.data.turn;
    openStep = null;
  }
  if (event.type === 'step/start') {
    assert.equal(openTurn, event.data.turn, 'step belongs to the open turn');
    assert.equal(event.data.step, 1, 'single-step turn');
    openStep = event.data.step;
  }
  if (event.type === 'assistant/message') {
    assert.equal(event.data.turn, openTurn, 'assistant inside its turn');
    assert.equal(event.data.step, openStep, 'assistant inside an open step');
  }
  if (event.type === 'step/end') {
    assert.equal(openStep, event.data.step, 'step closes the open step');
    openStep = null;
  }
  if (event.type === 'turn/end') {
    assert.equal(openTurn, event.data.turn, 'turn closes the open turn');
    assert.equal(openStep, null, 'no step left open when the turn closes');
    openTurn = null;
  }
}

// The one-per-session events exist exactly once and precede the first answer.
const once = (type) => events.filter((e) => e.type === type);
assert.equal(once('request/header').length, 1, 'one request header');
assert.equal(once('request/context').length, 1, 'one request context');
assert.equal(once('session/title').length, 1, 'one session title');

const header = once('request/header')[0];
assert.equal(header.data.header.config.provider, 'deepseek-web');
assert.equal(header.data.header.config.model, 'deepseek-web-chat');
assert.equal(header.data.reason, 'initial', 'the epoch reason is initial');

// The seed validator rejects an `adapterDefaults` marker whose key is absent
// from `config` — the exact failure "seed request/header at index N has invalid
// adapterDefaults" — so every marked key must be spelled out concretely.
const defaults = header.data.header.adapterDefaults;
assert.ok(defaults === undefined || typeof defaults === 'object', 'adapterDefaults is an object or omitted');
for (const [key, marker] of Object.entries(defaults ?? {})) {
  assert.equal(marker, true, `adapterDefaults.${key} is the literal true`);
  assert.ok(
    header.data.header.config[key] !== undefined,
    `config.${key} must be present because adapterDefaults marks it`,
  );
}
assert.deepEqual(Object.keys(defaults ?? {}).sort(), ['maxTokens'], 'only known adapter-default keys');
assert.equal(typeof header.data.header.config.maxTokens, 'number', 'config.maxTokens is concrete');

const context = once('request/context')[0];
assert.equal(context.data.provider, 'deepseek-web');
assert.equal(context.data.model, 'deepseek-web-chat');
assert.ok(context.data.contextWindow > 0, 'context window declared');

const title = once('session/title')[0];
assert.equal(title.data.title, META.title, 'title comes from the web conversation');
assert.equal(title.data.source.kind, 'fallback');
assert.ok(Array.isArray(title.data.messageSeqs) && title.data.messageSeqs.length === 1, 'title cites one message');
// The cited seq really is a user message.
const cited = events.find((e) => e.seq === title.data.messageSeqs[0]);
assert.equal(cited.type, 'user/message', 'title cites the first user message');

// Surface events carry a surfaceOp; bookkeeping events must not.
for (const event of events) {
  const isSurface = event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'system/message';
  if (isSurface) assert.equal(event.surfaceOp, 'append', `${event.type} carries surfaceOp`);
  else assert.equal(event.surfaceOp, undefined, `${event.type} carries no surfaceOp`);
}

// Timestamps are milliseconds.
assert.ok(events.every((e) => Number.isFinite(e.time) && e.time > 1_000_000_000_000), 'times are ms');

// Content is projected: reasoning precedes the answer in one block list.
const firstAssistant = once('assistant/message')[0];
const kinds = firstAssistant.data.message.content.map((block) => block.type);
assert.deepEqual(kinds, ['reasoning', 'text'], 'reasoning then text');
assert.equal(firstAssistant.data.message.source.provider, 'deepseek-web');

// A conversation with no usable text produces no events.
assert.equal(buildSeedEvents([{ message_id: 1, role: 'USER', fragments: [] }], META).length, 0);

// A missing title falls back to the first user text instead of an empty label.
const untitled = buildSeedEvents(messages, { ...META, title: '' });
const fallbackTitle = untitled.find((e) => e.type === 'session/title');
assert.equal(fallbackTitle.data.title, '你好', 'title falls back to the first user text');

console.log('seed.test.mjs: all assertions passed');
