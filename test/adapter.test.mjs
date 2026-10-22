// Structural test for the adapter's StreamChunk sequence and prompt hygiene.
//
// Runs offline against a scripted API double. It pins three contracts:
//   1. the chunk sequence the harness assembler relies on,
//   2. that only the newest HUMAN message is forwarded (never the system prompt,
//      never runtime context / skill catalogs, never earlier turns),
//   3. that auxiliary calls (session-title, compaction) never touch the web.
//
//   node test/adapter.test.mjs

import assert from 'node:assert';
import { DeepSeekWebAdapter, MODELS, isHarnessInjection, newestRealUser } from '../src/adapter.js';

/** An API double that records what the adapter asked for. */
function fakeApi(events) {
  const calls = { createSession: 0, completions: [], renames: [] };
  return {
    calls,
    async createSession() {
      calls.createSession += 1;
      return { id: 'web-1', title: null, updatedAt: 0 };
    },
    async renameSession(chatSessionId, title) {
      calls.renames.push({ chatSessionId, title });
    },
    async *streamCompletion(request) {
      calls.completions.push({
        prompt: request.prompt,
        thinking: request.thinking,
        search: request.search,
        chatSessionId: request.chatSessionId,
      });
      yield { kind: 'message', messageId: 2, parentId: 1 };
      for (const event of events) yield event;
      yield { kind: 'tokens', total: 42 };
      yield { kind: 'done' };
    },
  };
}

/** A user message shaped like the harness builds them. */
function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** One of the loop's own user-role messages, tagged with its real source kind. */
function injectedMessage(id, kind, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind, form: 'snapshot' } };
}

/** What the loop injects every turn and what must never reach the web. */
const RUNTIME_CONTEXT = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "C:\\\\x".';
const SKILLS = '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n<available_skills>\n- office: ...\n</available_skills>\n</system-reminder>';
/** The clock stanza: a SEPARATE user-role message the loop appends after the block above. */
const CLOCK_STANZA = 'Time sampled while preparing turn 1, step 1: 2026-10-22T10:54:20+08:00[Asia/Hong_Kong]\nBrowser time zone for this request: Asia/Hong_Kong. Interpret otherwise-unqualified dates and times in this zone.\nElapsed since the preceding model-visible message: unavailable.';
const ENV_TAIL = 'Current DSH file policy: danger-full-access.\n\nApproval policy: ask. Operations that require approval may be asked through the configured answerers.\n\nYou are the Team Lead named "lead".\n\nCurrent DeepSeek Harness implementation checkout: "D:\\\\x\\\\dsh\\\\".\n\nCurrent DeepSeek Harness Web GUI URL: "http://127.0.0.1:10140".';

function makeAdapter(events) {
  const api = fakeApi(events);
  const bindings = new Map();
  const sent = new Map();
  const adapter = new DeepSeekWebAdapter({
    api,
    resolveBinding: (id) => bindings.get(id),
    bindSession: (id, binding) => bindings.set(id, binding),
    updateBinding: (id, patch) => bindings.set(id, { ...bindings.get(id), ...patch }),
    noteSent: (sessionId, messageId) => {
      let seen = sent.get(sessionId);
      if (seen === undefined) {
        seen = new Set();
        sent.set(sessionId, seen);
      }
      if (seen.has(messageId)) return false;
      seen.add(messageId);
      return true;
    },
    warn: (message) => console.log('WARN', message),
  });
  return { adapter, bindings, api };
}

const THINK = (text) => ({ kind: 'fragment', fragmentType: 'THINK', text });
const ANSWER = (text) => ({ kind: 'fragment', fragmentType: 'RESPONSE', text });

// ── injection detection ────────────────────────────────────────────────────
assert.equal(isHarnessInjection(RUNTIME_CONTEXT), true, 'the environment block is an injection');
assert.equal(isHarnessInjection(CLOCK_STANZA), true, 'the clock/timezone stanza is an injection');
assert.equal(isHarnessInjection(ENV_TAIL), true, 'the policy tail is an injection');
assert.equal(isHarnessInjection(SKILLS), true, 'the skill catalog is an injection');
assert.equal(isHarnessInjection('   '), true, 'blank content is nothing to send');
assert.equal(isHarnessInjection('你是什么模型'), false, 'a real question is not an injection');
// A real question may mention one of these phrases; one marker alone is not enough.
assert.equal(
  isHarnessInjection('帮我看看 Browser time zone for this request 这句话是什么意思'),
  false,
  'a single marker inside a real question is not an injection',
);

// ── newestRealUser skips ALL injection stanzas, including the clock tail ───
{
  // The exact order the loop produces: the human message, then the environment
  // block, the skill catalog, and finally the clock stanza.
  const messages = [
    userMessage('m1', '你是什么模型'),
    injectedMessage('m2', 'runtime-context', RUNTIME_CONTEXT),
    injectedMessage('m3', 'skill-catalog', SKILLS),
    injectedMessage('m4', 'time-context', CLOCK_STANZA),
  ];
  const newest = newestRealUser(messages);
  assert.equal(newest.text, '你是什么模型', 'every injection stanza is skipped, including the clock');
  assert.equal(newest.id, 'm1', 'the human message identity is kept');
}

// ── the source kind is authoritative, not the text ────────────────────────
{
  // `user-approval` carries plain prose that reads like something a person said.
  const messages = [
    userMessage('m1', '我的问题'),
    injectedMessage('m2', 'user-approval', 'The approval policy changed from "ask" to "never" (changed by the user).'),
  ];
  assert.equal(newestRealUser(messages).text, '我的问题', 'a notice tagged user-approval is not human input');

  // Even when the body would pass the content heuristic, the tag wins.
  const looksHarmless = [
    userMessage('m1', '我的问题'),
    injectedMessage('m2', 'subagent-settled', '后台任务已完成。'),
  ];
  assert.equal(newestRealUser(looksHarmless).text, '我的问题', 'any non-user tag is excluded');
}

// ── request-only input (no source) still counts as human ──────────────────
{
  const messages = [{ role: 'user', content: [{ type: 'text', text: '没有 source 的输入' }] }];
  assert.equal(newestRealUser(messages).text, '没有 source 的输入', 'sourceless input is human by construction');
}

// ── the clock stanza alone must not become the prompt ─────────────────────
{
  const { adapter, api } = makeAdapter([ANSWER('不该发生')]);
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-web-chat',
    messages: [userMessage('m1', '我的问题'), injectedMessage('m2', 'time-context', CLOCK_STANZA)],
    sessionId: 'sess-clock',
  })) {
    chunks.push(chunk);
  }
  assert.equal(api.calls.completions.length, 1, 'one request reached the web');
  assert.equal(api.calls.completions[0].prompt, '我的问题', 'the human message is the prompt, not the clock stanza');
}

// ── reasoning then answer, with the prompt kept clean ──────────────────────
{
  const { adapter, bindings, api } = makeAdapter([THINK('先想'), THINK('一下'), ANSWER('答案是'), ANSWER('2')]);
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-web-reasoner',
    messages: [
      userMessage('m1', '1+1=?'),
      injectedMessage('m2', 'runtime-context', RUNTIME_CONTEXT),
      injectedMessage('m3', 'skill-catalog', SKILLS),
      injectedMessage('m4', 'time-context', CLOCK_STANZA),
    ],
    system: 'You are an AI agent. This must not be forwarded.',
    sessionId: 'sess-1',
  })) {
    chunks.push(chunk);
  }

  const starts = chunks.filter((c) => c.type === 'block-start');
  const ends = chunks.filter((c) => c.type === 'block-end');
  assert.equal(starts.length, 2, 'two blocks open');
  assert.equal(ends.length, 2, 'two blocks close, exactly once each');
  assert.equal(starts[0].blockType, 'reasoning');
  assert.equal(starts[1].blockType, 'text');

  const reasoningEnd = chunks.findIndex((c) => c.type === 'block-end' && c.block.type === 'reasoning');
  const textStart = chunks.findIndex((c) => c.type === 'block-start' && c.blockType === 'text');
  assert.ok(reasoningEnd < textStart, 'reasoning closes before text opens');

  const usageIndex = chunks.findIndex((c) => c.type === 'usage');
  const lastEnd = chunks.map((c) => c.type).lastIndexOf('block-end');
  assert.ok(usageIndex > lastEnd, 'usage follows the settled transcript');

  const terminal = chunks[chunks.length - 1];
  assert.equal(terminal.type, 'finish');
  assert.equal(terminal.reason.kind, 'stop');

  // The prompt is exactly the human message: no system, no context, no history.
  assert.equal(api.calls.completions.length, 1);
  const sent = api.calls.completions[0];
  assert.equal(sent.prompt, '1+1=?', 'only the human message is forwarded');
  assert.ok(!sent.prompt.includes('<conversation>'), 'no conversation wrapper');
  assert.ok(!sent.prompt.includes('Current runtime context'), 'no runtime context');
  assert.ok(!sent.prompt.includes('system-reminder'), 'no skill catalog');
  assert.ok(!sent.prompt.includes('You are an AI agent'), 'no system prompt');
  assert.equal(sent.thinking, true, 'the reasoner model enables thinking');
  assert.equal(sent.search, false, 'the reasoner model leaves search off');

  assert.deepEqual(bindings.get('sess-1'), { chatSessionId: 'web-1', parentMessageId: 2, seeded: true });

  // The first turn pins the web title to the same text DSH shows, because the
  // web product would otherwise paraphrase a Chinese question into English.
  assert.equal(api.calls.renames.length, 1, 'the first turn renames the web conversation');
  assert.equal(api.calls.renames[0].title, '1+1=?', 'the title comes from the user message');
}

// ── a repeated user message must not re-ask the model ───────────────────────
{
  const { adapter, api } = makeAdapter([ANSWER('回答')]);
  const options = {
    provider: 'deepseek-web',
    model: 'deepseek-web-chat',
    messages: [userMessage('m1', '1+1=?')],
    sessionId: 'sess-2',
  };
  const first = [];
  for await (const chunk of adapter.stream(options)) first.push(chunk);
  assert.equal(first[first.length - 1].type, 'finish');
  assert.ok(first.length > 1, 'the first call really streamed');

  const second = [];
  for await (const chunk of adapter.stream(options)) second.push(chunk);
  assert.equal(second.length, 1, 'the repeat is a single empty stop');
  assert.equal(second[0].type, 'finish');
  assert.equal(api.calls.completions.length, 1, 'the repeat never reached the web');
}

// ── auxiliary calls never touch the web ────────────────────────────────────
{
  const { adapter, api } = makeAdapter([ANSWER('unused')]);

  const title = [];
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-web-chat',
    purpose: 'session-title',
    messages: [userMessage('m1', '帮我写一个 Python 快速排序'), userMessage('m2', RUNTIME_CONTEXT)],
    sessionId: 'sess-3',
  })) title.push(chunk);

  assert.equal(api.calls.createSession, 0, 'title generation creates no web conversation');
  assert.equal(api.calls.completions.length, 0, 'title generation sends nothing to the web');
  const titleText = title.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(titleText, '帮我写一个 Python 快速排序', 'the title comes from the first human message');
  assert.equal(title.at(-1).type, 'finish');

  const digest = [];
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-web-chat',
    purpose: 'compaction',
    messages: [
      userMessage('m1', '第一问'),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '第一答' }], source: { kind: 'model', provider: 'x', model: 'y' } },
      userMessage('m2', RUNTIME_CONTEXT),
      userMessage('m3', '第二问'),
    ],
    sessionId: 'sess-4',
  })) digest.push(chunk);

  assert.equal(api.calls.createSession, 0, 'compaction creates no web conversation');
  assert.equal(api.calls.completions.length, 0, 'compaction sends nothing to the web');
  const digestText = digest.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.ok(digestText.includes('第一问'), 'the digest keeps human turns');
  assert.ok(digestText.includes('第二问'), 'the digest keeps later human turns');
  assert.ok(!digestText.includes('Current runtime context'), 'the digest drops injections');
}

// ── search models reach the request ────────────────────────────────────────
{
  const withSearch = MODELS.filter((entry) => entry.search === true).map((entry) => entry.id);
  assert.ok(withSearch.length > 0, 'at least one search-enabled model is offered');
  for (const id of withSearch) {
    const { adapter, api } = makeAdapter([ANSWER('ok')]);
    for await (const _chunk of adapter.stream({
      provider: 'deepseek-web',
      model: id,
      messages: [userMessage('m1', '今天有什么新闻')],
      sessionId: `sess-${id}`,
    })) {
      /* drain */
    }
    assert.equal(api.calls.completions[0].search, true, `${id} requests web search`);
  }
}

// ── answer-only replies never open a reasoning block ───────────────────────
{
  const { adapter } = makeAdapter([ANSWER('直接回答')]);
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-web-chat',
    messages: [userMessage('m9', 'hi')],
    sessionId: 'sess-5',
  })) {
    chunks.push(chunk);
  }
  const starts = chunks.filter((c) => c.type === 'block-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].blockType, 'text');
}

// ── a turn with only injections asks nothing ───────────────────────────────
{
  const { adapter, api } = makeAdapter([ANSWER('should not happen')]);
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-web-chat',
    messages: [
      injectedMessage('m1', 'runtime-context', RUNTIME_CONTEXT),
      injectedMessage('m2', 'skill-catalog', SKILLS),
      injectedMessage('m3', 'time-context', CLOCK_STANZA),
    ],
    sessionId: 'sess-6',
  })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 1, 'nothing to say');
  assert.equal(chunks[0].type, 'finish');
  assert.equal(api.calls.createSession, 0, 'and no web conversation is minted');
}

console.log('adapter.test.mjs: all assertions passed');
