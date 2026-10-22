/**
 * Execute the browser half in a Node sandbox and render its settings page.
 *
 * This is the only way to catch a component that throws at render time without
 * a browser attached: it mocks the ModuleLoader, `react`, `react/jsx-runtime`,
 * `document` and `fetch`, then walks the page through its states.
 *
 *   node test/client-render.test.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client.js');
const source = fs.readFileSync(bundlePath, 'utf8');

// ── a minimal element tree ───────────────────────────────────────────────────
// Mirrors react/jsx-runtime exactly: the third argument is the KEY and children
// live in `props.children`. A component that passed text as the third argument
// would lose it, and this harness must catch that.
const FRAGMENT = Symbol('react.fragment');

const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxs = jsx;

// ── a tiny hook system so useState/useEffect work outside React ─────────────
let stateCursor = 0;
let stateValues = [];
let pendingEffects = [];

const react = {
  Fragment: FRAGMENT,
  useState(initial) {
    const index = stateCursor++;
    const value = index < stateValues.length ? stateValues[index] : initial;
    return [value, (next) => { stateValues[index] = typeof next === 'function' ? next(stateValues[index]) : next; }];
  },
  useEffect(effect) { pendingEffects.push(effect); },
  useCallback(fn) { return fn; },
  useRef(initial) { return { current: initial }; },
  useMemo(fn) { return fn(); },
  createElement: jsx,
};

/** Flush queued effects once. */
function flushEffects() {
  const queued = pendingEffects;
  pendingEffects = [];
  for (const effect of queued) {
    const cleanup = effect();
    if (typeof cleanup === 'function') void cleanup;
  }
}

/** Render a component with a given hook-state prefix. */
function render(Component, props, values) {
  stateCursor = 0;
  stateValues = values.slice();
  pendingEffects = [];
  const tree = Component(props);
  return { tree, values: stateValues };
}

/** Depth-first walk of the element tree, expanding function components. */
function* walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    yield { text: String(node) };
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  // Function components are not rendered by the runtime in this harness, so
  // expand them here. They must not use hooks (only the page component does).
  if (typeof node.type === 'function') {
    yield* walk(node.type(node.props));
    return;
  }
  yield node;
  const children = node.props?.children;
  if (children !== undefined) yield* walk(children);
}

/** All text content in a tree. */
function textOf(tree) {
  const parts = [];
  for (const node of walk(tree)) {
    if ('text' in node) parts.push(node.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ── run the bundle in a sandbox ─────────────────────────────────────────────
let registration = null;
const fakeCtx = {
  slots: {
    inject(name, callback) {
      callback();
      return () => {};
    },
    register(options, Component) {
      registration = { options, Component };
      return () => {};
    },
  },
  locale: {
    register() { return () => {}; },
    bind() { return (key) => key; },
  },
  effect() { return () => {}; },
};

const fetchCalls = [];
const fakeDocument = { baseURI: 'http://127.0.0.1:1767/', documentElement: { lang: 'zh-CN' } };

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, 'dsh-deepseek-web', 'bundle id');
        // The real loader uses the factory's RETURN value as module.exports;
        // the factory keeps its own `module` object internally.
        sandbox.__exports = definition.factory((name) => {
          if (name === 'react') return react;
          if (name === 'react/jsx-runtime') return { jsx, jsxs, Fragment: FRAGMENT };
          throw new Error('unexpected require: ' + name);
        });
      },
    },
  },
  document: fakeDocument,
  console,
  fetch: async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        plugin: 'deepseek-web',
        provider: 'deepseek-web',
        models: [
          { id: 'deepseek-web-chat', name: 'DeepSeek 网页版', description: '普通对话' },
          { id: 'deepseek-web-reasoner', name: 'DeepSeek 网页版 · 深度思考', description: '深度思考' },
        ],
        workspaceTitle: '对话',
        workspaceId: 'ws-1',
        conversationDir: 'C:/x/conversations',
        stateFile: 'C:/x/state.json',
        hasToken: true,
        tokenTail: '****ABCD',
        imported: 5,
        lastSyncAt: Date.now() - 120000,
        autoSyncSeconds: 60,
        capabilities: { workspace: true, agentLoop: true, webServer: true },
      }),
    };
  },
  URL,
  Date,
  Math,
  JSON,
  Symbol,
};

// The bundle assigns to `window.__ModuleLoader__`; run it with that as global.
const fn = new Function('window', 'document', 'console', 'fetch', 'URL', 'Date', 'Math', 'JSON', 'Symbol', source);
fn(sandbox.window, sandbox.document, sandbox.console, sandbox.fetch, URL, Date, Math, JSON, Symbol);

const exportsObj = sandbox.__exports;
assert.ok(exportsObj, 'factory ran and produced exports');
assert.equal(typeof exportsObj.apply, 'function', 'apply exported');
assert.deepEqual(exportsObj.inject, ['slots', 'locale'], 'inject list');

// ── apply registers one settings page ──────────────────────────────────────
exportsObj.apply(fakeCtx);
assert.ok(registration, 'settings.section registration happened');
assert.equal(registration.options.name, 'settings.section');
assert.equal(registration.options.id, 'deepseek-web');
assert.equal(registration.options.order, 120);
assert.ok(registration.options.label, 'has a label');

const Page = registration.Component;
assert.equal(typeof Page, 'function', 'registered value is a component');

// ── state 1: still loading ─────────────────────────────────────────────────
{
  const { tree } = render(Page, {}, [null, '', '', null]);
  const text = textOf(tree);
  console.log('loading state text:', JSON.stringify(text));
  assert.ok(text.length > 0, 'loading state renders text (not a blank page)');
}

// ── state 2: loaded ────────────────────────────────────────────────────────
{
  const { tree } = render(Page, {}, [
    {
      models: [
        { id: 'deepseek-web-chat', name: 'DeepSeek 网页版', description: '普通对话' },
        { id: 'deepseek-web-reasoner', name: 'DeepSeek 网页版 · 深度思考', description: '深度思考' },
      ],
      workspaceTitle: '对话',
      workspaceId: 'ws-1',
      conversationDir: 'C:/x/conversations',
      stateFile: 'C:/x/state.json',
      hasToken: true,
      tokenTail: '****ABCD',
      imported: 5,
      lastSyncAt: Date.now() - 120000,
      autoSyncSeconds: 300,
    },
    '',
    '',
    null,
  ]);
  const text = textOf(tree);
  console.log('loaded state text:', JSON.stringify(text.slice(0, 220)));
  assert.ok(text.includes('连接'), 'connection section renders');
  assert.ok(text.includes('对话同步'), 'sync section renders');
  assert.ok(text.includes('模型'), 'model section renders');
  assert.ok(text.includes('已导入'), 'imported count renders');
  // The credential guide must actually reach the page: it is the only place the
  // user learns where a token comes from.
  assert.ok(text.includes('如何获取 user token'), 'the token guide renders');
  assert.ok(text.includes('localStorage.userToken'), 'the guide shows the exact console command');
  assert.ok(text.includes('保存并验证'), 'the guide points at the save button');
  // The reload escape hatch: an import can land before the sidebar indexes do.
  assert.ok(text.includes('热重载并刷新'), 'the hot reload button renders');
  assert.ok(text.includes('重建会话索引'), 'the hint explains what the reload does');
  // The auto-sync cadence is visible, so a user can tell why the sidebar lags.
  assert.ok(text.includes('自动同步'), 'the auto-sync row renders');
  assert.ok(text.includes('每 5 分钟'), 'the interval is shown in minutes');
}

console.log('\nclient-render.test.mjs: all assertions passed');
