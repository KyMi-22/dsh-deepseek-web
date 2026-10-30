// Offline tests for incremental import: turning the part of a web conversation
// that arrived after the import into events appended to the existing session.
//
// Two layers are pinned here:
//
//   - `planAppend` is the pure part. It decides which web messages are new,
//     refuses to append half an exchange, and numbers the turns after the ones
//     already in the log.
//   - `appendConversationTurns` owns the write handle. It has to close a turn
//     torn by an earlier failure, keep the anchor when nothing usable arrived,
//     and release the handle on every path.
//
//   node test/append.test.mjs

import assert from 'node:assert';
import { appendConversationTurns, planAppend } from '../src/sync.js';

const META = { provider: 'deepseek-web', model: 'deepseek-web-chat' };

/** One exchange in the shape the history endpoint returns. */
function exchange(id, text, reply, reasoning = '') {
  const fragments = [{ id: id * 10, type: 'THINK', content: reasoning }, { id: id * 10 + 1, type: 'RESPONSE', content: reply }];
  return [
    {
      message_id: id,
      parent_id: id - 1,
      role: 'USER',
      inserted_at: 1792592800 + id,
      fragments: [{ id: id * 10 + 2, type: 'REQUEST', content: text }],
    },
    {
      message_id: id + 1,
      parent_id: id,
      role: 'ASSISTANT',
      inserted_at: 1792592800 + id + 1,
      fragments: fragments.filter((fragment) => fragment.content !== ''),
    },
  ];
}

// ── planAppend: the pure conversion ───────────────────────────────────────
{
  const messages = [...exchange(1, '你好', '你好！'), ...exchange(3, '再问一句', '好的。', '用户在追问。')];

  const plan = planAppend(messages, { afterMessageId: 2, ...META });
  assert.equal(plan.ok, true);
  assert.equal(plan.reason, null);
  assert.equal(plan.turns, 1, 'only the exchange after the anchor is new');
  assert.equal(plan.nextMessageId, 4, 'the anchor moves to the last appended answer');
  assert.equal(plan.events.length, 6, 'one turn = six events');

  assert.deepEqual(
    plan.events.map((event) => event.type),
    ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'],
    'the live-loop vocabulary, without the one-per-session events',
  );
  assert.deepEqual(plan.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5], 'seq is dense from baseSeq');
  assert.equal(plan.events[0].data.turn, 1, 'the first appended turn follows startTurn');
  assert.equal(plan.events[2].surfaceOp, 'append');
  assert.equal(plan.events[3].surfaceOp, 'append');
  assert.equal(plan.events[1].surfaceOp, undefined, 'bookkeeping events carry no surfaceOp');

  const assistant = plan.events[3].data.message;
  assert.deepEqual(assistant.content.map((block) => block.type), ['reasoning', 'text'], 'reasoning precedes the answer');
  assert.equal(assistant.source.provider, 'deepseek-web');
  assert.equal(assistant.source.model, 'deepseek-web-chat');

  const user = plan.events[2].data;
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].text, '再问一句');
  assert.equal(user.source.kind, 'user');
  assert.equal(user.message, undefined, 'user/message carries the message itself, not a wrapper');
  assert.equal(user.turn, undefined, 'turn belongs to turn/start, not the user message');
}

// ── planAppend: continuation numbering ────────────────────────────────────
{
  const messages = [...exchange(1, 'a', 'b'), ...exchange(3, 'c', 'd'), ...exchange(5, 'e', 'f')];
  const plan = planAppend(messages, { afterMessageId: 2, startTurn: 7, baseSeq: 100, ...META });
  assert.equal(plan.turns, 2);
  assert.deepEqual(plan.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [7, 8]);
  assert.deepEqual(plan.events.map((event) => event.seq), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
  assert.equal(plan.nextMessageId, 6);
}

// ── planAppend: half an exchange is left for the next pass ────────────────
{
  const messages = [...exchange(1, 'a', 'b'), messagesUser(3, '还在生成的问题')];
  const plan = planAppend(messages, { afterMessageId: 2, ...META });
  assert.equal(plan.ok, true);
  assert.equal(plan.turns, 0, 'a question with no answer is not appended');
  assert.equal(plan.events.length, 0);
  assert.equal(plan.nextMessageId, 2, 'the anchor does not move');

  // Two questions in a row: the first has no answer in the history, and
  // skipping it would silently drop content.
  const doubled = [...exchange(1, 'a', 'b'), messagesUser(3, '第一个问题'), messagesUser(4, '第二个问题')];
  const stopped = planAppend(doubled, { afterMessageId: 2, ...META });
  assert.equal(stopped.turns, 0, 'an unanswered question stops the plan');
}

// ── planAppend: the anchor is mandatory ───────────────────────────────────
{
  const messages = [...exchange(1, 'a', 'b')];
  assert.deepEqual(planAppend(messages, { afterMessageId: 99, ...META }), {
    ok: false,
    reason: 'anchor-missing',
    events: [],
    nextMessageId: null,
    turns: 0,
  }, 'an absent anchor cannot be located in a truncated history');
  assert.equal(planAppend(messages, { ...META }).reason, 'no-anchor', 'a missing anchor is refused');
  assert.equal(planAppend(messages, { afterMessageId: null, ...META }).reason, 'no-anchor');
  assert.equal(planAppend(null, { afterMessageId: 1, ...META }).reason, 'no-anchor');

  // Nothing after the anchor is a normal no-op, not a failure.
  const none = planAppend(messages, { afterMessageId: 2, ...META });
  assert.equal(none.ok, true);
  assert.equal(none.turns, 0);
  assert.equal(none.nextMessageId, 2);
}

// ── planAppend: file fragments keep their marker ──────────────────────────
{
  const messages = [
    ...exchange(1, 'a', 'b'),
    {
      message_id: 3,
      role: 'USER',
      inserted_at: 1792592810,
      fragments: [{ type: 'FILE', content: '报告.pdf' }],
    },
    {
      message_id: 4,
      role: 'ASSISTANT',
      inserted_at: 1792592811,
      fragments: [{ type: 'RESPONSE', content: '收到' }],
    },
  ];
  const plan = planAppend(messages, { afterMessageId: 2, ...META });
  assert.equal(plan.turns, 1);
  assert.equal(plan.events[2].data.content[0].text, '[文件] 报告.pdf');
}

// ── appendConversationTurns: the write path ───────────────────────────────
{
  const messages = [...exchange(1, '你好', '你好！'), ...exchange(3, '新增的一问', '新增的一答')];

  /** A stored log for the first exchange only. */
  const storedLog = () => [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ];

  const persistence = fakePersistence(storedLog());
  const result = await appendConversationTurns({
    persistence,
    sessionId: 'session-1',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(result.ok, true);
  assert.equal(result.appended, 1);
  assert.equal(result.nextMessageId, 4);
  assert.equal(result.events[0].seq, 6, 'seq continues after the stored tail');
  assert.equal(result.events[0].data.turn, 2, 'turn numbering continues after the stored tail');
  assert.equal(persistence.calls.reads, 2, 'the append is read back to validate the stored records');
}

// A torn turn (a previous append died before it closed) is closed before the
// new turn opens; otherwise two turns are open at once.
{
  const torn = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
  ];
  const messages = [...exchange(1, '照旧', '照旧答'), ...exchange(3, '新问题', '新答案')];
  const persistence = fakePersistence(torn);
  const result = await appendConversationTurns({
    persistence,
    sessionId: 'session-1',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['step/end', 'turn/end', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'],
    'the torn turn closes first',
  );
  assert.deepEqual(result.events[0].data, { turn: 1, step: 1 });
  assert.deepEqual(result.events[1].data, { turn: 1, reason: { kind: 'interrupted' } });
  assert.equal(result.events[2].data.turn, 2, 'the new turn keeps counting from the stored tail');
  assert.equal(result.events[2].seq, 5, 'seq continues past the two repair events');
  assert.equal(persistence.calls.flushed, 1, 'the repair is flushed like any other append');
}

// A torn turn is repaired even when no new exchange arrived: the repair alone
// is durable work, so it must be flushed rather than silently dropped.
{
  const torn = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
  ];
  const persistence = fakePersistence(torn);
  const result = await appendConversationTurns({
    persistence,
    sessionId: 'session-1',
    messages: [...exchange(1, '照旧', '照旧答')],
    afterMessageId: 2,
    ...META,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'repaired');
  assert.equal(result.appended, 0);
  assert.deepEqual(result.events.map((event) => event.type), ['step/end', 'turn/end']);
  assert.equal(persistence.calls.flushed, 1, 'the repair is flushed on its own');
}

// Nothing usable after the anchor: the handle still opens, reads and closes,
// but nothing is appended and the anchor is returned unchanged.
{
  const persistence = fakePersistence(storedTail());
  const messages = [...exchange(1, 'a', 'b'), messagesUser(3, '还没有回答')];
  const result = await appendConversationTurns({
    persistence,
    sessionId: 'session-1',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'no-new-messages');
  assert.equal(result.appended, 0);
  assert.equal(result.nextMessageId, 2);
  assert.equal(persistence.calls.appended.length, 0, 'no half turn reaches the log');
  assert.equal(persistence.calls.flushed, 0, 'nothing to flush');
  assert.equal(persistence.calls.closed, 1, 'the handle is always released');
}

// ── appendConversationTurns: every failure maps to a reason ───────────────
{
  const messages = [...exchange(1, 'a', 'b'), ...exchange(3, 'c', 'd')];

  const noService = await appendConversationTurns({ sessionId: 's', messages, afterMessageId: 2, ...META });
  assert.equal(noService.ok, false);
  assert.equal(noService.reason, 'no-persistence');

  const busy = await appendConversationTurns({
    persistence: fakePersistence([], { openError: namedError('SessionAlreadyOwnedError') }),
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(busy.reason, 'busy', 'a live writer is a transient condition');

  const missing = await appendConversationTurns({
    persistence: fakePersistence([], { openError: namedError('SessionPersistenceNotFoundError') }),
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(missing.reason, 'missing');

  const empty = await appendConversationTurns({
    persistence: fakePersistence([]),
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(empty.reason, 'empty-log');

  const anchorless = await appendConversationTurns({
    persistence: fakePersistence(storedTail()),
    sessionId: 's',
    messages,
    afterMessageId: 99,
    ...META,
  });
  assert.equal(anchorless.reason, 'anchor-missing');
  assert.equal(anchorless.events.length, 0);

  const appendPersistence = fakePersistence(storedTail(), { appendError: new Error('disk full') });
  const appendBroke = await appendConversationTurns({
    persistence: appendPersistence,
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(appendBroke.reason, 'failed');
  assert.equal(appendBroke.ok, false);
  assert.equal(appendPersistence.calls.closed, 1, 'a failed append still releases the writer');

  const flushPersistence = fakePersistence(storedTail(), { flushError: new Error('flush failed') });
  const flushBroke = await appendConversationTurns({
    persistence: flushPersistence,
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(flushBroke.reason, 'failed', 'a failed durability barrier is a failed append');
  assert.equal(flushPersistence.calls.closed, 1);

  // The post-append read is the storage validator: a record shape it refuses
  // must turn into a reported failure, not a silently corrupt log.
  // A log whose turn numbers regress is already broken (a live agent's cached
  // boundary was bypassed). Appending on top would compound it; the caller
  // repairs by re-importing instead.
  const corruptOrder = await appendConversationTurns({
    persistence: fakePersistence([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 2, time: 1, data: { turn: 3 } },
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 3, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 4, time: 1, data: { turn: 2 } },
    ]),
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(corruptOrder.reason, 'corrupt-order');
  assert.equal(corruptOrder.ok, false);

  const readBackPersistence = fakePersistence(storedTail(), { readErrorAt: 2 });
  const readBackBroke = await appendConversationTurns({
    persistence: readBackPersistence,
    sessionId: 's',
    messages,
    afterMessageId: 2,
    ...META,
  });
  assert.equal(readBackBroke.reason, 'failed');
  assert.equal(readBackPersistence.calls.reads, 2, 'the failure came from the validation read, not the priming read');
  assert.equal(readBackPersistence.calls.closed, 1);
}

console.log('append.test.mjs: all assertions passed');

// ── helpers ───────────────────────────────────────────────────────────────

/** A bare user message. */
function messagesUser(id, text) {
  return {
    message_id: id,
    parent_id: id - 1,
    role: 'USER',
    inserted_at: 1792592800 + id,
    fragments: [{ id: id * 10, type: 'REQUEST', content: text }],
  };
}

/** A closed one-turn log. */
function storedTail() {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 1, data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

/** A named error, as the persistence service throws them. */
function namedError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * A persistence double that records every handle interaction.
 *
 * @param {Array<object>} events
 * @param {{ openError?: Error, appendError?: Error, flushError?: Error, readErrorAt?: number, readError?: Error }} [behaviour]
 *   `readErrorAt` is the 1-based read call that throws; the second read is the
 *   post-append validation pass.
 */
function fakePersistence(events, behaviour = {}) {
  const calls = { opened: null, appended: [], flushed: 0, closed: 0, reads: 0 };
  const handle = {
    read: async () => {
      calls.reads += 1;
      if (behaviour.readErrorAt === calls.reads) throw behaviour.readError ?? new Error('corrupt log');
      return { events: events.map((event) => ({ ...event })) };
    },
    append: async (incoming) => {
      if (behaviour.appendError !== undefined) throw behaviour.appendError;
      calls.appended.push(...incoming);
    },
    flush: async () => {
      calls.flushed += 1;
      if (behaviour.flushError !== undefined) throw behaviour.flushError;
    },
    close: async () => {
      calls.closed += 1;
    },
  };
  return {
    calls,
    open: async (id, access) => {
      calls.opened = { id, access };
      if (behaviour.openError !== undefined) throw behaviour.openError;
      return handle;
    },
  };
}
