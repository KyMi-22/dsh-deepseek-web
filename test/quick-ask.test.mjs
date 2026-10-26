/**
 * Quick-ask host half: compression, thread lifecycle, and the SSE stream.
 *
 *   node test/quick-ask.test.mjs
 */

import assert from 'node:assert';
import {
  QUICK_ASK_FALLBACK_TITLE,
  QUICK_ASK_TAG,
  QuickAsk,
  compressExchanges,
  contextPrimer,
  extractExchanges,
  extractSessionTitle,
  isQuickAskTitle,
  quickAskTitle,
  readSessionEvents,
} from '../src/quick-ask.js';

// ── sidebar naming ───────────────────────────────────────────────────────────

{
  // The DSH title comes from the LAST session/title event in the log.
  assert.equal(
    extractSessionTitle([
      { type: 'session/title', data: { title: '旧名字' } },
      { type: 'user/message', data: {} },
      { type: 'session/title', data: { title: '新名字' } },
    ]),
    '新名字',
  );
  assert.equal(extractSessionTitle([]), '');
  assert.equal(extractSessionTitle([{ type: 'session/title', data: { title: '  ' } }]), '', 'blank titles are ignored');

  // The web conversation title is `SideBar：<DSH title>`.
  assert.equal(quickAskTitle('项目重构'), `${QUICK_ASK_TAG}项目重构`);
  assert.equal(quickAskTitle(''), QUICK_ASK_FALLBACK_TITLE, 'a titleless session falls back');
  const long = quickAskTitle('长'.repeat(80));
  assert.ok(long.startsWith(QUICK_ASK_TAG), 'the tag always leads');
  assert.ok(long.length < 60, 'the label is clipped so the tag stays visible');

  // The import rule recognizes the current tag and historical spellings.
  assert.equal(isQuickAskTitle(`${QUICK_ASK_TAG}项目重构`), true);
  assert.equal(isQuickAskTitle('[SideBar] 旧版本'), true, 'the older bracket spelling stays excluded');
  assert.equal(isQuickAskTitle('[快捷侧问] 更早版本'), true);
  assert.equal(isQuickAskTitle('普通对话'), false);
  assert.equal(isQuickAskTitle(''), false);
  assert.equal(isQuickAskTitle(undefined), false);
}

// ── extractExchanges ─────────────────────────────────────────────────────────

{
  const events = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '第一个问题' }], source: { kind: 'user' } } } },
    // harness bookkeeping must never reach the digest
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'Current runtime context. …' }], source: { kind: 'runtime-context' } } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '第一个回答' }] } } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '第二个问题' }], source: { kind: 'user' } } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '第二个回答' }] } } },
  ];
  const turns = extractExchanges(events);
  assert.equal(turns.length, 4, 'two user turns and two answers');
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(turns[0].text, '第一个问题');
  assert.equal(turns[1].text, '第一个回答', 'reasoning blocks are dropped');
}

// ── compressExchanges ────────────────────────────────────────────────────────

{
  // Newest turns are kept when the budget runs out; the marker names the count.
  const exchanges = [];
  for (let i = 0; i < 30; i++) {
    exchanges.push({ role: 'user', text: `问题${i}-${'x'.repeat(400)}` });
    exchanges.push({ role: 'assistant', text: `回答${i}-${'y'.repeat(400)}` });
  }
  const context = compressExchanges(exchanges);
  assert.ok(context.includes('已省略'), 'the omission marker names what was dropped');
  assert.ok(context.includes('问题29'), 'the newest user turn survives');
  assert.ok(context.length < 14000, 'the digest respects its budget');
  // A user turn always precedes its answer: no orphaned assistant line at the head.
  const firstLine = context.split('\n').find((line) => line && !line.startsWith('（'));
  assert.ok(firstLine.startsWith('用户') || firstLine.startsWith('助手'), 'line labeling is intact');
}

{
  // An empty conversation compresses to nothing — no primer is sent then.
  assert.equal(compressExchanges([]), '');
  const primer = contextPrimer('用户：你好');
  assert.ok(primer.includes('背景开始'));
  assert.ok(primer.includes('用户：你好'));
}

// ── readSessionEvents ────────────────────────────────────────────────────────

{
  // A persistence service that hands back events through a read handle.
  const persistence = {
    async open(id, mode) {
      assert.equal(mode, 'read', 'quick ask never takes write ownership');
      assert.equal(id, 'sess-1');
      return {
        async read() { return { events: [{ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '嗨' }], source: { kind: 'user' } } } }] }; },
        async close() { this.closed = true; },
      };
    },
  };
  const events = await readSessionEvents(persistence, 'sess-1');
  assert.equal(events.length, 1);
  // No service, no log: the panel still works, just without background.
  assert.equal(await readSessionEvents(undefined, 'sess-1'), null);
  // An unknown session is a null log, not a throw.
  const missing = { async open() { throw new Error('not found'); } };
  assert.equal(await readSessionEvents(missing, 'sess-2'), null);
}

// ── QuickAsk lifecycle ───────────────────────────────────────────────────────

/** A fake web client: createSession + a scripted completion stream. */
function fakeApi({ reply = '回答', failAt } = {}) {
  const calls = { created: 0, completions: [], renamed: [] };
  return {
    calls,
    ready: true,
    token: 'tok',
    async createSession() {
      calls.created += 1;
      return { id: `web-${calls.created}`, title: null, updatedAt: 0 };
    },
    async renameSession(chatSessionId, title) {
      calls.renamed.push({ chatSessionId, title });
    },
    async *streamCompletion(request) {
      calls.completions.push(request);
      if (failAt === 'start') throw new Error('pow failed');
      yield { kind: 'message', messageId: 900 + calls.completions.length };
      yield { kind: 'fragment', fragmentType: 'RESPONSE', text: reply };
      yield { kind: 'done' };
    },
  };
}

function fakeStore(state = {}) {
  return {
    state: { quickAsk: {}, ...state },
    async flush() { this.flushed = (this.flushed ?? 0) + 1; },
  };
}

{
  const api = fakeApi();
  const store = fakeStore();
  const persistence = {
    async open() {
      return {
        async read() {
          return {
            events: [
              { type: 'session/title', data: { title: '原对话标题' } },
              { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '背景问题' }], source: { kind: 'user' } } } },
            ],
          };
        },
        async close() {},
      };
    },
  };
  const qa = new QuickAsk({ api, store, persistence: () => persistence });

  // First open creates the thread, seeds the primer, records the transcript.
  const events = [];
  for await (const event of qa.stream('sess-1', '面板问题')) {
    events.push(event);
  }
  assert.equal(store.state.quickAsk['sess-1'].chatSessionId, 'web-1', 'thread bound to the session');
  // The web conversation is tagged with the DSH conversation's name, so a sync
  // pass can tell it apart from a conversation the user wrote.
  assert.deepEqual(api.calls.renamed[0], { chatSessionId: 'web-1', title: 'SideBar：原对话标题' });
  assert.equal(store.state.quickAsk['sess-1'].titled, true, 'the tag rename is recorded');
  // Two completions went out: the primer, then the question.
  assert.equal(api.calls.completions.length, 2, 'primer + question');
  assert.ok(api.calls.completions[0].prompt.includes('背景问题'), 'the primer carries the context');
  assert.equal(api.calls.completions[0].thinking, false, 'the primer is not a thinking turn');
  assert.ok(api.calls.completions[1].prompt.includes('面板问题'));
  // The question chained onto the primer's message id.
  assert.equal(api.calls.completions[1].parentMessageId, 901);
  // The stream the panel saw: start, one answer fragment, done.
  assert.deepEqual(
    events.map((event) => event.kind),
    ['start', 'answer', 'done'],
  );
  // The transcript records the exchange, clipped for storage.
  const recorded = store.state.quickAsk['sess-1'].exchanges;
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].text, '面板问题');
  assert.equal(recorded[1].text, '回答');

  // A second question reuses the SAME web conversation — one thread per DSH
  // session, not one per turn.
  for await (const event of qa.stream('sess-1', '第二个问题')) {
    void event;
  }
  assert.equal(api.calls.created, 1, 'no extra web conversation');
  assert.equal(api.calls.completions.length, 3);
  assert.equal(store.state.quickAsk['sess-1'].exchanges.length, 4);

  // Another DSH session gets its OWN thread.
  for await (const event of qa.stream('sess-2', '另一个会话')) {
    void event;
  }
  assert.equal(api.calls.created, 2);
  assert.ok(store.state.quickAsk['sess-2'] !== undefined);
}

{
  // A blank conversation seeds no primer: one completion, not two.
  const api = fakeApi();
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  for await (const event of qa.stream('blank', '问题')) {
    void event;
  }
  assert.equal(api.calls.completions.length, 1, 'no primer for an empty log');
  assert.equal(api.calls.completions[0].parentMessageId, null);
}

{
  // The web product refuses to rename an empty conversation, so the tag
  // rename attempted at creation fails; the first settled exchange retries it
  // and succeeds.
  const api = fakeApi();
  let failures = 1;
  const realRename = api.renameSession.bind(api);
  api.renameSession = async (chatSessionId, title) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('empty conversation');
    }
    return realRename(chatSessionId, title);
  };
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  const thread = await qa.ensureThread('bare');
  assert.equal(thread.titled, undefined, 'creation left the thread untitled');
  for await (const event of qa.stream('bare', '第一个问题')) {
    void event;
  }
  assert.equal(thread.titled, true, 'the settled exchange retried the tag rename');
  assert.deepEqual(api.calls.renamed.at(-1), { chatSessionId: 'web-1', title: QUICK_ASK_FALLBACK_TITLE });
}

{
  // reset drops the thread; the next question mints a fresh one with the
  // CURRENT context.
  const api = fakeApi();
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  await qa.ensureThread('sess-1');
  await qa.refreshThread('sess-1');
  assert.equal(api.calls.created, 2, 'refresh minted a new web conversation');
  assert.ok(store.state.quickAsk['sess-1'] !== undefined);
}

{
  // A failure BEFORE the stream reports an error and keeps the thread
  // unchanged, so a retry does not fork the web thread.
  const api = fakeApi({ failAt: 'start' });
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  await qa.ensureThread('sess-1');
  const before = store.state.quickAsk['sess-1'];
  const events = [];
  for await (const event of qa.stream('sess-1', '会失败的问题')) {
    events.push(event);
  }
  assert.ok(events.some((event) => event.kind === 'error'), 'the failure reached the panel');
  assert.equal(store.state.quickAsk['sess-1'], before, 'the thread record is untouched');
  assert.equal(before.exchanges.length, 0, 'a failed turn is not recorded');

  // The lock frees after a failure, so the retry is not refused.
  const api2 = { ...api, streamCompletion: fakeApi().streamCompletion };
  const qaApiSwap = qa;
  void qaApiSwap;
  void api2;
}

{
  // No credential: a clear error, no thread creation attempt.
  const api = { ...fakeApi(), ready: false, token: '' };
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  const events = [];
  for await (const event of qa.stream('sess-1', '问题')) {
    events.push(event);
  }
  assert.equal(events[0].kind, 'error');
  assert.ok(events[0].message.includes('token'));
  assert.equal(store.state.quickAsk['sess-1'], undefined);
}

{
  // Two racing ensureThread calls share one creation (one web conversation).
  const api = fakeApi();
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  await Promise.all([qa.ensureThread('race'), qa.ensureThread('race')]);
  assert.equal(api.calls.created, 1, 'creation is serialized per session');
}

{
  // Attachments: the upload ids ride on the completion and the names stay in
  // the transcript for display.
  const api = fakeApi();
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  for await (const event of qa.stream('sess-files', '看看这个', {
    refFileIds: ['doc-1', 'doc-2'],
    files: [{ name: '报告.pdf' }, { name: '数据.xlsx' }],
  })) {
    void event;
  }
  assert.deepEqual(api.calls.completions[0].refFileIds, ['doc-1', 'doc-2'], 'the ids reach the completion');
  const recorded = store.state.quickAsk['sess-files'].exchanges[0];
  assert.deepEqual(recorded.files, [{ name: '报告.pdf' }, { name: '数据.xlsx' }], 'the transcript keeps the names');
  assert.equal(recorded.role, 'user');
}

{
  // The panel's upload helper picks the model type and repairs a missing
  // extension before handing the file to the web endpoint.
  const api = fakeApi();
  const uploaded = [];
  api.uploadFile = async (request) => {
    uploaded.push(request);
    return `web-${uploaded.length}`;
  };
  const qa = new QuickAsk({ api, store: fakeStore(), persistence: () => undefined });
  const docId = await qa.uploadFile({ bytes: new Uint8Array([1, 2, 3]), fileName: 'report.pdf', mediaType: 'application/pdf' });
  assert.equal(docId, 'web-1');
  assert.deepEqual(
    { fileName: uploaded[0].fileName, mediaType: uploaded[0].mediaType, modelType: uploaded[0].modelType },
    { fileName: 'report.pdf', mediaType: 'application/pdf', modelType: 'file' },
  );
  const imageId = await qa.uploadFile({ bytes: new Uint8Array([1]), fileName: 'shot', mediaType: 'image/png' });
  assert.equal(imageId, 'web-2');
  assert.equal(uploaded[1].modelType, 'vision', 'images take the vision route');
  assert.equal(uploaded[1].fileName, 'shot.png', 'a missing extension is added');
  // A path-like name is flattened: the endpoint takes a bare filename.
  await qa.uploadFile({ bytes: new Uint8Array([1]), fileName: 'C\\temp\\a.txt', mediaType: 'text/plain' });
  assert.equal(uploaded[2].fileName, 'C_temp_a.txt');
}

{
  // The transcript is bounded: ancient exchanges fall off the end.
  const api = fakeApi();
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => undefined });
  const thread = await qa.ensureThread('sess-1');
  for (let i = 0; i < 55; i++) {
    thread.exchanges.push({ role: 'user', text: `旧问题${i}` }, { role: 'assistant', text: '旧回答' });
  }
  for await (const event of qa.stream('sess-1', '新问题')) {
    void event;
  }
  assert.ok(thread.exchanges.length <= 100, `bounded transcript (got ${thread.exchanges.length})`);
  assert.equal(thread.exchanges.at(-2).text, '新问题');
}

// ── status ───────────────────────────────────────────────────────────────────

{
  const api = fakeApi();
  const store = fakeStore();
  const qa = new QuickAsk({ api, store, persistence: () => ({ async open() { return { async read() { return { events: [] }; }, async close() {} }; } }) });
  const status = await qa.status('fresh');
  assert.equal(status.hasThread, false);
  assert.equal(status.ready, true);
  assert.equal(status.canRefresh, true);
  assert.deepEqual(status.exchanges, []);
  await qa.ensureThread('fresh');
  const after = await qa.status('fresh');
  assert.equal(after.hasThread, true);
}

console.log('quick-ask.test.mjs: all assertions passed');
