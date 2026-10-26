/**
 * dsh-deepseek-web — Host half.
 *
 * Three jobs live here:
 *
 * 1. **A model route.** The adapter in `src/adapter.js` is registered as
 *    `deepseek-web` with two model ids, so the picker offers the web product
 *    beside the metered API. Turns run against chat.deepseek.com and therefore
 *    cost nothing on the API account.
 *
 * 2. **A conversations workspace.** `src/sync.js` imports every web
 *    conversation as a seeded DSH session whose `cwd` is this plugin's
 *    conversation directory, which makes the sidebar render them as the 对话
 *    workspace with no shipped UI shadowed.
 *
 * 3. **The settings surface.** One same-origin JSON route feeds the browser
 *    half: credential status, sync state, and the manual sync trigger.
 *
 * Everything degrades: with no credential the route still answers (so the page
 * can ask for one), and a composition without a workspace registry or an agent
 * loop imports nothing instead of failing to mount.
 *
 * @module dsh-deepseek-web
 */

import { DeepSeekWebApi } from './src/api.js';
import { DeepSeekWebAdapter, MODELS, PROVIDER } from './src/adapter.js';
import {
  conversationDir,
  ensureConversationDir,
  StateStore,
  stateFile,
} from './src/store.js';
import { attachSessions, buildSeedEvents, createSeededSession, ensureWorkspace, lastMessageId, mintSessionId, nextSyncDelayMs, planTitlePush, resolveSyncWindowStart, selectImportBatch, undoImports, WORKSPACE_TITLE } from './src/sync.js';
import { readJsonBody, readRawBody, sendJson } from './src/http.js';
import { readFile } from 'node:fs/promises';
import { isToolAllowedInWebSession, toolRejectionMessage } from './src/tool-guard.js';
import { QuickAsk } from './src/quick-ask.js';

export { isToolAllowedInWebSession } from './src/tool-guard.js';

/** Stable Cordis plugin name. */
export const name = 'deepseek-web';

/** The one service this plugin cannot exist without. */
export const inject = ['llm'];

/** Same-origin route prefix owned by this plugin. */
export const API_PREFIX = '/dsh-deepseek-web/api';

/** The model rows the settings page renders; built once, it is constant data. */
const MODEL_SUMMARY = MODELS.map((entry) => ({ id: entry.id, name: entry.name, description: entry.description }));

/**
 * The model rows the quick-ask panel's composer menu renders.
 *
 * Carries the web request flags (`thinking`/`search`) too, so the panel can
 * pick a route without duplicating the model table on the browser side.
 */
const QUICK_ASK_MODELS = MODELS.map((entry) => ({
  id: entry.id,
  name: entry.name,
  description: entry.description,
  thinking: entry.thinking,
  search: entry.search,
}));

/** How many per-conversation failures one sync report carries. */
const MAX_REPORTED_ERRORS = 5;

/** Hard cap for one file handed to the web upload endpoint (bytes). */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Ask the harness to recompose the plugin tree.
 *
 * Session rows created by an import reach the sidebar through indexes the HMR
 * pass rebuilds, so this is the supported way to make them appear without
 * restarting the application. A composition without the HMR service (headless,
 * for instance) reports that instead of pretending to have reloaded.
 *
 * @param {any} ctx
 * @param {(message: string) => void} warn
 * @returns {Promise<{ ok: boolean, warnings?: string[], pending?: number, restartReason?: string | null, error?: string }>}
 */
async function triggerHotReload(ctx, warn) {
  let hmr;
  try {
    hmr = ctx.get('hmr');
  } catch {
    hmr = undefined;
  }
  if (hmr === undefined || hmr === null
    || typeof hmr.runExclusive !== 'function'
    || typeof hmr.reconcileProfile !== 'function') {
    return { ok: false, error: 'hmr-unavailable' };
  }
  try {
    const outcome = await hmr.runExclusive(() => hmr.reconcileProfile());
    return {
      ok: true,
      warnings: Array.isArray(outcome?.warnings) ? outcome.warnings.map(String) : [],
      pending: Array.isArray(outcome?.pending) ? outcome.pending.length : 0,
      restartReason: typeof outcome?.restartReason === 'string' ? outcome.restartReason : null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`deepseek-web: hot reload failed: ${detail}`);
    return { ok: false, error: detail };
  }
}

/**
 * Mount the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export async function apply(ctx, config = {}) {
  /** Plugin-owned diagnostics. */
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* a missing logger must not break the plugin */
    }
  };
  const info = (message) => {
    try {
      ctx.logger?.info?.(message);
    } catch {
      /* same */
    }
  };

  const store = await StateStore.open();
  /**
   * Credential resolution, highest priority first:
   *
   *   1. the `DEEPSEEK_WEB_TOKEN` environment variable — never written to disk
   *   2. the bundle `token` config field
   *   3. `state.json`, written by the settings page
   *
   * The environment route exists so a user who does not want a long-lived web
   * token sitting in a JSON file can supply it per launch instead.
   */
  const envToken = (process.env.DEEPSEEK_WEB_TOKEN ?? '').trim();
  const configuredToken = typeof config.token === 'string' ? config.token.trim() : '';
  if (envToken !== '') {
    info('deepseek-web: using DEEPSEEK_WEB_TOKEN from the environment; any stored token is ignored');
  } else if (configuredToken !== '' && configuredToken !== store.token) {
    await store.setToken(configuredToken);
  }
  const resolvedToken = envToken !== '' ? envToken : store.token;
  /** Where the active credential came from; updated when the page saves one. */
  let tokenSource = envToken !== '' ? 'env' : (store.token !== '' ? 'state' : 'none');

  /**
   * The endpoint the credential may be sent to.
   *
   * Only `https:` is accepted: a bearer token over plain http is sent in clear
   * text, so a misconfigured or mistyped `baseUrl` must fall back to the default
   * rather than quietly leak the credential to a plaintext endpoint.
   */
  const baseUrl = (() => {
    const raw = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
    if (raw === '') return undefined;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      warn(`deepseek-web: ignoring an unparsable baseUrl (${raw}); using the default`);
      return undefined;
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      warn(`deepseek-web: refusing a non-https baseUrl (${raw}) because it would send the token in clear text; using the default`);
      return undefined;
    }
    return raw;
  })();

  const api = new DeepSeekWebApi({
    token: resolvedToken,
    deviceId: store.state.deviceId,
    baseUrl,
  });

  // ── adapter ───────────────────────────────────────────────────────────────
  /** Sessions already prompted, so one turn cannot re-ask the model. */
  const promptedMessages = new Map();

  const adapter = new DeepSeekWebAdapter({
    api,
    resolveBinding: (sessionId) => store.binding(sessionId),
    bindSession: (sessionId, binding) => {
      // The binding alone is the durable record of a web conversation created for
      // a NEW DSH session. It must NOT go into the import ledger as well: the
      // ledger means "came from the web", and undo deletes what the ledger names.
      // Deduplication reads the bindings (`selectImportBatch`'s excludeIds), so
      // keeping the two records separate changes nothing about repeated passes
      // and stops an undo from deleting a conversation the user started here.
      store.setBinding(sessionId, binding);
    },
    updateBinding: (sessionId, patch) => {
      const current = store.binding(sessionId);
      if (current === undefined) return;
      store.setBinding(sessionId, { ...current, ...patch });
    },
    noteSent: (sessionId, messageId) => {
      let seen = promptedMessages.get(sessionId);
      if (seen === undefined) {
        seen = new Set();
        promptedMessages.set(sessionId, seen);
      }
      if (seen.has(messageId)) return false;
      seen.add(messageId);
      return true;
    },
    forgetSent: (sessionId, messageId) => {
      // Called back when the attempt failed before anything reached the model, so
      // the loop may retry the same message instead of being told "already sent".
      promptedMessages.get(sessionId)?.delete(messageId);
    },
    onExchange: (sessionId, chatSessionId, userText, assistantText, reasoning) => {
      // Must not be a bare `void`: persistExchange awaits store.flush(), which now
      // rejects when disk persistence fails. Dropping that rejection produces an
      // unhandled-rejection that terminates a plain Node process, and the adapter
      // only wraps the synchronous call so it cannot catch it either.
      persistExchange(sessionId, chatSessionId, userText, assistantText, reasoning).catch((error) => {
        warn(`deepseek-web: could not record the exchange: ${String(error)}`);
      });
    },
    warn,
  });

  // Image uploads read bytes out of the Host's attachment store. The service is
  // resolved lazily: the adapter only touches it for turns that actually carry
  // images, and a missing service degrades to a clear per-turn error instead of
  // failing plugin load on deployments that mount no attachment store.
  adapter.deps.readImage = async (ref) => {
    const attachments = ctx.get('attachments');
    if (attachments?.readImage === undefined) {
      throw new Error('deepseek-web: no attachment service is mounted');
    }
    try {
      return await attachments.readImage(ref);
    } catch (error) {
      // The store validates stored bytes against the reference; when that fails,
      // record both sides so the log shows WHICH field disagreed.
      if (error instanceof Error && error.message.includes('does not match')) {
        let actual = '(unreadable)';
        try {
          const hostPath = attachments.imageHostPath?.(ref);
          if (typeof hostPath === 'string') {
            const data = await readFile(hostPath);
            actual = `${data.length} bytes, header ${data.subarray(0, 3).toString('hex')}`;
          }
        } catch {
          /* the diagnostic must not mask the original error */
        }
        warn(
          `deepseek-web: attachment ${ref.attachmentId} ref=${JSON.stringify({
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          })} stored=${actual}`,
        );
      }
      throw error;
    }
  };

  // Document uploads read the verbatim bytes out of the same attachment store.
  // `readFileStream` yields bounded chunks; the upload endpoint needs one
  // buffer, so they are joined here under a hard size cap.
  adapter.deps.readFileBytes = async (ref) => {
    const attachments = ctx.get('attachments');
    if (typeof attachments?.readFileStream !== 'function') {
      throw new Error('deepseek-web: no attachment service is mounted');
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of attachments.readFileStream(ref)) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        throw new Error(`deepseek-web: file is larger than the ${MAX_UPLOAD_BYTES}-byte upload limit`);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };

  // Both registrations are fiber-owned: their handles unwind with this plugin.
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'DeepSeek 网页版',
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
    },
  ]);

  // ── tool guard ────────────────────────────────────────────────────────────
  // The web endpoint has no function-calling channel, so tools are never
  // invoked against it. This guard is the second line of defence: if a tool does
  // reach execution inside a web-backed session, anything not explicitly known to
  // be read-only is refused. Fail closed — an unknown tool is denied.
  //
  // Membership is read from the DURABLE binding ledger, not from an in-memory set
  // of sessions seen this process. An in-memory set would be empty right after a
  // plugin reload, which would silently lift the guard for every web conversation
  // already running.
  const tools = ctx.get('tools');
  if (tools?.guard !== undefined) {
    ctx.effect(() =>
      tools.guard((execution) => {
        const sessionId = execution?.agent?.id;
        if (sessionId === undefined || sessionId === null) return undefined;
        if (store.binding(String(sessionId)) === undefined) return undefined;
        const name = execution.name;
        if (isToolAllowedInWebSession(name)) return undefined;
        return toolRejectionMessage(name);
      }),
    );
  }

  // ── import / sync ─────────────────────────────────────────────────────────
  // These services are resolved on use rather than captured here: a composition
  // may mount the workspace registry or the agent loop after this plugin, and a
  // captured `undefined` would silently disable importing for the whole session.
  const workspaceRegistry = () => ctx.get('workspaceRegistry');
  const agentLoop = () => ctx.get('agentLoop');

  let directory = conversationDir();
  try {
    directory = await ensureConversationDir();
  } catch (error) {
    warn(`deepseek-web: could not create the conversation directory: ${String(error)}`);
  }

  /**
   * One import pass. Returns a compact report the settings page renders.
   *
   * Passes are serialized. Two concurrent passes (a manual click racing the
   * background timer) would both read the ledger before either wrote it, decide
   * the same conversation is new, and create two DSH sessions for it — the exact
   * duplicate the import is supposed to avoid. A second caller joins the pass
   * already in flight rather than starting another.
   */
  let syncInFlight = null;
  /**
   * Undos waiting or running. A boolean was not enough: two overlapping undos both
   * cleared it, so the first to finish reopened synchronization while the second
   * was still tearing down — and a pass could then rebuild the ledger the second
   * undo was clearing.
   */
  let pendingUndos = 0;
  /** Serializes undos so their teardown steps never interleave. */
  let undoQueue = Promise.resolve();
  function enqueueUndo(task) {
    pendingUndos += 1;
    const run = undoQueue.then(task, task).finally(() => {
      pendingUndos -= 1;
    });
    undoQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  function syncNow(options = {}) {
    if (pendingUndos > 0) {
      // An undo is tearing the import down; starting a pass now would recreate
      // the ledger it is clearing and clear the pause it just set.
      return Promise.resolve({ skipped: 'undo-in-progress' });
    }
    if (syncInFlight !== null) return syncInFlight;
    syncInFlight = performSync(options).finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  async function performSync(options = {}) {
    const { limit = Infinity, reason = 'manual' } = options;
    const report = {
      reason,
      at: Date.now(),
      listed: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      attached: 0,
      attachFailed: 0,
      errors: [],
      windowStart: 0,
      inWindow: 0,
      alreadyBound: 0,
      workspaceId: store.state.workspaceId,
      workspaceError: null,
      error: null,
    };

    /** Persist the report so a crash or throw still leaves evidence behind. */
    const checkpoint = async () => {
      store.state.lastReport = JSON.parse(JSON.stringify(report));
      try {
        await store.flush();
      } catch {
        /* a diagnostic write must never mask the real failure */
      }
    };

    if (!api.ready) {
      report.error = 'no-token';
      await checkpoint();
      return report;
    }
    try {
      const sessions = await api.listSessions();
      report.listed = sessions.length;
      // Narrow the pass to a recent window, oldest first. `attachSession`
      // prepends, so importing oldest-first leaves the newest conversation at
      // the top of the sidebar.
      const since = resolveSyncWindowStart(syncWindow);
      // A conversation this plugin CREATED for a new DSH session already has a
      // bound DSH session. Importing it again would produce a second, empty copy
      // of the same conversation, so those ids are excluded before selection.
      // Quick-ask threads are the same kind of machinery (they belong to a DSH
      // session's side panel, not to the sidebar): the ledger ids cover the
      // window before a thread's `SideBar：` rename lands, and the title tag
      // (checked in `selectImportBatch`) covers threads the ledger no longer
      // knows — a refresh mints a NEW web id that the tag still marks.
      const boundChatIds = new Set([
        ...Object.values(store.state.bindings)
          .map((binding) => binding?.chatSessionId)
          .filter((id) => typeof id === 'string' && id !== ''),
        ...Object.values(store.state.quickAsk ?? {})
          .map((thread) => thread?.chatSessionId)
          .filter((id) => typeof id === 'string' && id !== ''),
      ]);
      const inWindow = selectImportBatch(sessions, since);
      const batch = selectImportBatch(sessions, since, boundChatIds);
      report.windowStart = since;
      report.inWindow = batch.length;
      report.alreadyBound = inWindow.length - batch.length;
      // Services are resolved per pass, not at mount time: the workspace
      // registry and the agent loop may be loaded after this plugin.
      const provisioned = await ensureWorkspace(
        { workspaceRegistry: workspaceRegistry() },
        directory,
        warn,
      );
      report.workspaceError = provisioned.error;
      store.state.lastWorkspaceError = provisioned.error;
      if (provisioned.workspaceId !== null) {
        report.workspaceId = provisioned.workspaceId;
        if (store.state.workspaceId !== provisioned.workspaceId) {
          store.state.workspaceId = provisioned.workspaceId;
          void store.flush();
        }
      }
      // A session joins a workspace only when its stored `cwd` equals the
      // workspace's canonical path character for character — `attachSession`
      // rejects any difference and silently leaves the session ungrouped. The
      // workspace entity owns that canonical string, so it is the authority for
      // everything this pass creates.
      const sessionCwd = provisioned.workspace?.path ?? directory;
      report.sessionCwd = sessionCwd;
      await checkpoint();
      let importedNow = 0;
      for (const summary of batch) {
        const known = store.state.imported[summary.id];
        if (known !== undefined) {
          report.skipped++;
          if (summary.updatedAt > known.updatedAt) {
            known.updatedAt = summary.updatedAt;
            void store.flush();
          }
          continue;
        }
        if (importedNow >= limit) {
          report.skipped++;
          continue;
        }
        importedNow++;
        try {
          const history = await api.getHistory(summary.id);
          if (history === null) {
            report.failed++;
            continue;
          }
          const seed = buildSeedEvents(history.messages, {
            title: summary.title,
            provider: PROVIDER,
            model: MODELS[0].id,
          });
          if (seed.length === 0) {
            report.skipped++;
            continue;
          }
          const dshSessionId = mintSessionId();
          const created = await createSeededSession({
            ctx,
            agentLoop: agentLoop(),
            sessionId: dshSessionId,
            cwd: sessionCwd,
            seed,
            provider: PROVIDER,
            model: MODELS[0].id,
            warn,
          });
          if (!created.ok) {
            report.failed++;
            if (report.errors.length < MAX_REPORTED_ERRORS) {
              // Deliberately no conversation title: the report is persisted to
              // state.json, and the title is private text from the user's chats.
              report.errors.push({ chatSessionId: summary.id, error: created.error });
            }
            // Persisted, not just remembered: a failed import must stay
            // diagnosable after a restart.
            store.state.lastSyncError = created.error;
            await checkpoint();
            continue;
          }
          store.recordImported({
            chatSessionId: summary.id,
            dshSessionId,
            updatedAt: summary.updatedAt,
            messageCount: history.messages.length,
          });
          store.setBinding(dshSessionId, {
            chatSessionId: summary.id,
            parentMessageId: lastMessageId(history.messages),
            seeded: true,
            // Provenance: this one was pulled FROM the web, so undo may delete it.
            origin: 'imported',
          });
          report.imported++;
        } catch (error) {
          report.failed++;
          warn(`deepseek-web: importing ${summary.id} failed: ${String(error)}`);
        }
      }

      // Creating a workspace does not adopt the sessions already in its
      // directory: membership is an explicit record, so the pass attaches every
      // imported session (new and previously imported alike). Re-running this is
      // harmless — an attached session is a no-op.
      if (provisioned.workspace !== null && provisioned.workspace !== undefined) {
        const ids = Object.values(store.state.imported)
          .map((entry) => entry?.dshSessionId)
          .filter((id) => typeof id === 'string' && id !== '');
        const attached = await attachSessions(provisioned.workspace, ids, warn);
        report.attached = attached.attached;
        report.attachFailed = attached.failed;
        if (attached.failed > 0) {
          store.state.lastWorkspaceError = `${attached.failed} 个会话未能加入工作区`;
          const firstAttachError = attached.errors[0];
          if (firstAttachError !== undefined) store.state.lastSyncError = `join workspace: ${firstAttachError}`;
        }
      } else {
        report.attachFailed = Object.keys(store.state.imported).length;
      }

      store.state.lastSyncAt = Date.now();
      if (report.failed === 0) store.state.lastSyncError = null;
      // A manual or automatic pass proves the user wants the import, so it lifts
      // any pause an undo left behind.
      store.state.syncPausedUntil = 0;
      await checkpoint();
    } catch (error) {
      report.error = String(error?.message ?? error);
      store.state.lastSyncError = report.error;
      warn(`deepseek-web: sync failed: ${String(error)}`);
      await checkpoint();
    }
    return report;
  }

  /** Record one completed exchange in the plugin's own ledger. */
  async function persistExchange(sessionId, chatSessionId, userText, assistantText, reasoning) {
    const imported = store.state.imported[chatSessionId];
    if (imported !== undefined) {
      imported.updatedAt = Math.floor(Date.now() / 1000);
      imported.messageCount += 2;
      await store.flush();
    }
    void sessionId;
    void userText;
    void assistantText;
    void reasoning;
  }

  /**
   * Mirror a DSH rename onto the bound web conversation.
   *
   * The session log is the source of truth for the title: a rename inside DSH
   * commits a `session/title` event, and that carries the same label the sidebar
   * shows. Pushing it here keeps both sides reading the same, instead of the web
   * product keeping whatever paraphrased title it generated on the first turn.
   *
   * Seeded title events never reach this feed (seed events are not published), so
   * importing a conversation cannot trigger a spurious rename.
   */
  const pushedTitles = new Map();
  async function pushTitleToWeb(sessionId, event) {
    if (!api.ready) return;
    const planned = planTitlePush(event, sessionId, (id) => store.binding(id));
    if (planned === null) return;
    const { chatSessionId, title } = planned;
    const key = `${chatSessionId}\u0000${title}`;
    if (pushedTitles.get(chatSessionId) === key) return;
    pushedTitles.set(chatSessionId, key);
    try {
      await api.renameSession(chatSessionId, title);
    } catch (error) {
      // A conversation with no messages yet refuses a rename; that is not worth
      // even a warning, and clearing the memo lets a later rename retry.
      pushedTitles.delete(chatSessionId);
      warn(`deepseek-web: could not sync the title to the web conversation: ${String(error)}`);
    }
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const sessionId = session?.id;
      if (sessionId === undefined || sessionId === null) return;
      void pushTitleToWeb(String(sessionId), event);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  });

  // Background sync. It is deliberately slow and serial: the settings page can
  // always force a pass, and a list request on a metronome is the one pattern
  // that says "this is a script". The default mean is five minutes, and each
  // delay is jittered around it — a person refreshes a conversation list when
  // they feel like it, not on an exact beat. Set `syncIntervalSeconds: 0` to
  // make syncing manual-only.
  //
  // `syncWindow` bounds which conversations a pass looks at: a number of trailing
  // days (default 7), 'month', 'all', or the deprecated alias 'week' which now
  // means the same trailing seven days. A long account would otherwise import
  // hundreds of conversations the user has no interest in seeing in the sidebar.
  const syncWindow = config.syncWindow ?? 7;
  const intervalSeconds = Number(config.syncIntervalSeconds ?? 300);
  /** Whether the timer is actually armed; reported so the page cannot claim otherwise. */
  const autoSyncEnabled = Number.isFinite(intervalSeconds) && intervalSeconds > 0 && config.autoSync !== false;
  if (autoSyncEnabled) {
    ctx.effect(() => {
      let timer = null;
      let stopped = false;
      const scheduleNext = () => {
        if (stopped) return;
        timer = setTimeout(() => {
          if (stopped) return;
          // Honor an undo: re-importing seconds after the user cleared
          // everything would make the button look broken.
          const paused = Date.now() < store.state.syncPausedUntil;
          // Awaited so a slow pass can never overlap the next one; `syncNow`
          // also guards against a manual pass arriving mid-flight.
          const run = paused ? Promise.resolve() : syncNow({ limit: 5, reason: 'auto' });
          void run.finally(scheduleNext);
        }, nextSyncDelayMs(intervalSeconds));
        if (typeof timer.unref === 'function') timer.unref();
      };
      scheduleNext();
      return () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      };
    });
  }

  // ── settings route ────────────────────────────────────────────────────────
  // Quick-ask controller: one instance per mount, sharing the credential and
  // the state store with the adapter. The persistence service is resolved on
  // use (like the workspace registry) because it may mount after this plugin.
  const quickAsk = new QuickAsk({
    api,
    store,
    persistence: () => ctx.get('sessionPersistence'),
    warn,
  });

  const webServer = ctx.get('webServer');
  if (webServer?.register !== undefined) {
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          // Fail closed. Without the connection trust fence this route answers
          // any local process, and it exposes the credential tail and mutates the
          // stored credential and the imported sessions. A composition that
          // cannot admit the request must not be treated as admitting it.
          let rejection;
          try {
            const connection = ctx.get('connection');
            if (typeof connection?.requestRejection !== 'function') {
              res.statusCode = 503;
              res.end();
              return;
            }
            rejection = connection.requestRejection(req);
          } catch {
            res.statusCode = 403;
            res.end();
            return;
          }
          if (typeof rejection === 'number') {
            res.statusCode = rejection;
            res.end();
            return;
          }
          const url = new URL(String(req.url ?? '/'), 'http://localhost');
          const route = url.pathname.slice(API_PREFIX.length) || '/';
          try {
            if (req.method === 'GET' && (route === '/status' || route === '/')) {
              sendJson(res, 200, {
                plugin: name,
                provider: PROVIDER,
                models: MODEL_SUMMARY,
                workspaceTitle: WORKSPACE_TITLE,
                workspaceId: store.state.workspaceId,
                conversationDir: directory,
                stateFile: stateFile(),
                hasToken: api.ready,
                tokenTail: api.ready ? maskToken(api.token) : '',
                tokenSource,
                // Background bookkeeping writes (bindings, ledger rows) are
                // best-effort; surfacing the last failure is the only way the user
                // learns that state stopped reaching the disk.
                lastWriteError: store.lastWriteError,
                imported: Object.keys(store.state.imported).length,
                lastSyncAt: store.state.lastSyncAt,
                autoSyncSeconds: autoSyncEnabled ? intervalSeconds : 0,
                syncWindow,
                windowStart: resolveSyncWindowStart(syncWindow),
                capabilities: {
                  workspace: workspaceRegistry() !== undefined,
                  agentLoop: agentLoop() !== undefined,
                  webServer: true,
                },
                lastWorkspaceError: store.state.lastWorkspaceError,
                lastReport: store.state.lastReport,
                lastSyncError: store.state.lastSyncError,
              });
              return;
            }
            if (req.method === 'POST' && route === '/token') {
              if (envToken !== '') {
                // The environment wins by design; storing a token here would be
                // silently ignored, which reads as a broken save.
                sendJson(res, 409, {
                  ok: false,
                  error: 'token-from-environment',
                  detail: 'DEEPSEEK_WEB_TOKEN is set; unset it to manage the token from this page',
                });
                return;
              }
              const body = await readJsonBody(req);
              const token = typeof body.token === 'string' ? body.token.trim() : '';
              if (token === '') {
                sendJson(res, 400, { ok: false, error: 'empty-token' });
                return;
              }
              // Verify with a throwaway client first: persisting an unverified
              // credential would leave the page reporting "configured" while every
              // later request fails, and would overwrite a working token with a
              // broken one.
              const probe = new DeepSeekWebApi({
                token,
                deviceId: store.state.deviceId,
                baseUrl,
              });
              let account = null;
              try {
                const me = await probe.currentUser();
                account = { id: me.id, name: me.id_profile?.name ?? '', email: me.email ?? '' };
              } catch (error) {
                sendJson(res, 400, { ok: false, error: 'invalid-token', detail: String(error?.message ?? error) });
                return;
              }
              // Persist before switching the live client. A failed write must not
              // report success: the page would say "saved" while the next launch
              // silently restored the previous credential.
              try {
                await store.setToken(token);
              } catch (error) {
                sendJson(res, 500, {
                  ok: false,
                  error: 'persist-failed',
                  detail: String(error?.message ?? error),
                });
                return;
              }
              api.configure({ token });
              tokenSource = 'state';
              sendJson(res, 200, { ok: true, account });
              return;
            }
            if (req.method === 'POST' && route === '/sync') {
              const body = await readJsonBody(req);
              const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Number(body.limit) : Infinity;
              const report = await syncNow({ limit, reason: 'manual' });
              sendJson(res, 200, report);
              return;
            }
            if (req.method === 'POST' && route === '/reload') {
              // Recompose the plugin tree through the official HMR service. The
              // session rows the import just created only reach the sidebar after
              // the workspace/session indexes are rebuilt, and this is the
              // supported way to force that without restarting the application.
              const reloaded = await triggerHotReload(ctx, warn);
              sendJson(res, 200, reloaded);
              return;
            }
            if (req.method === 'POST' && route === '/undo') {
              // Remove every artifact of the import: archive everything living
              // in the conversation directory (including conversations started
              // inside DSH, which have no import record), delete the files of the
              // sessions this plugin itself imported, then drop the workspace and
              // the ledger. The credential and the web account stay untouched so
              // a re-import is one click.
              //
              // Serialized against sync: an import pass still in flight would
              // otherwise recreate the ledger and clear the pause right after the
              // undo finished. Waiting is enough because `syncNow` also refuses to
              // start while `pendingUndos` is above zero.
              if (syncInFlight !== null) {
                try {
                  await syncInFlight;
                } catch {
                  /* a failed pass has nothing to protect */
                }
              }
              // Undos are serialized too: two overlapping teardowns interleave
              // their archive/delete steps and each clears the other's ledger.
              const undo = await enqueueUndo(() =>
                undoImports({
                  imported: store.state.imported,
                  workspaceId: store.state.workspaceId,
                  directory,
                  registry: workspaceRegistry(),
                  query: ctx.get('sessionQuery'),
                  bindings: store.state.bindings,
                  warn,
                }),
              );
              // Only forget what actually went away. Clearing the whole ledger on a
              // partial failure would discard exactly the rows a retry needs.
              const stuck = new Set(undo.failedSessionIds ?? []);
              const kept = {};
              for (const [chatSessionId, entry] of Object.entries(store.state.imported)) {
                if (stuck.has(String(entry?.dshSessionId))) kept[chatSessionId] = entry;
              }
              const stuckChatIds = new Set(Object.keys(kept));
              const keptBindings = {};
              for (const [sessionId, binding] of Object.entries(store.state.bindings)) {
                if (stuckChatIds.has(String(binding?.chatSessionId))) keptBindings[sessionId] = binding;
              }
              store.state.imported = kept;
              store.state.bindings = keptBindings;
              store.state.workspaceId = undo.workspaceError === null ? null : store.state.workspaceId;
              store.state.lastSyncAt = 0;
              // Give the user time to decide before background sync rebuilds it.
              store.state.syncPausedUntil = Date.now() + 10 * 60_000;
              promptedMessages.clear();
              store.state.lastWorkspaceError = undo.workspaceError;
              store.state.lastSyncError = null;
              store.state.lastReport = null;
              await store.flush();
              sendJson(res, 200, { ok: undo.failedSessions === 0 && undo.archiveFailed === 0, ...undo });
              return;
            }
            if (req.method === 'POST' && route === '/verify') {
              try {
                const me = await api.currentUser();
                sendJson(res, 200, { ok: true, account: { id: me.id, name: me.id_profile?.name ?? '', email: me.email ?? '' } });
              } catch (error) {
                sendJson(res, 200, { ok: false, detail: String(error?.message ?? error) });
              }
              return;
            }
            // ── quick-ask panel routes ───────────────────────────────────────
            if (req.method === 'GET' && route === '/quick-ask/status') {
              const sessionId = url.searchParams.get('sessionId') ?? '';
              if (sessionId === '') {
                sendJson(res, 400, { ok: false, error: 'missing-session' });
                return;
              }
              sendJson(res, 200, { ...(await quickAsk.status(sessionId)), models: QUICK_ASK_MODELS });
              return;
            }
            if (req.method === 'POST' && route === '/quick-ask/reset') {
              const body = await readJsonBody(req);
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
              if (sessionId === '') {
                sendJson(res, 400, { ok: false, error: 'missing-session' });
                return;
              }
              if (!api.ready) {
                sendJson(res, 409, { ok: false, error: 'no-token' });
                return;
              }
              try {
                const thread = await quickAsk.refreshThread(sessionId);
                sendJson(res, 200, { ok: true, exchanges: thread.exchanges.map((row) => ({ ...row })) });
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
              }
              return;
            }
            if (req.method === 'POST' && route === '/quick-ask/upload') {
              // Raw bytes, filename and media type in the query, because the
              // browser already holds the File object. The body cap is enforced
              // while reading.
              const fileName = url.searchParams.get('name') ?? '';
              const mediaType = url.searchParams.get('type') ?? '';
              if (!api.ready) {
                sendJson(res, 409, { ok: false, error: 'no-token' });
                return;
              }
              let bytes;
              try {
                bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
              } catch (error) {
                if (error?.code === 'TOO_LARGE') {
                  sendJson(res, 413, { ok: false, error: 'too-large', detail: `上限 ${MAX_UPLOAD_BYTES} 字节` });
                  return;
                }
                throw error;
              }
              if (bytes.length === 0) {
                sendJson(res, 400, { ok: false, error: 'empty-file' });
                return;
              }
              try {
                const fileId = await quickAsk.uploadFile({
                  bytes,
                  fileName,
                  mediaType,
                });
                sendJson(res, 200, { ok: true, fileId, name: fileName });
              } catch (error) {
                sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
              }
              return;
            }
            if (req.method === 'POST' && route === '/quick-ask/send') {
              const body = await readJsonBody(req);
              const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
              const prompt = typeof body.prompt === 'string' ? body.prompt : '';
              if (sessionId === '' || prompt.trim() === '') {
                sendJson(res, 400, { ok: false, error: 'missing-session-or-prompt' });
                return;
              }
              if (!api.ready) {
                sendJson(res, 409, { ok: false, error: 'no-token' });
                return;
              }
              // The generation is cancelled by the request aborting; forward it.
              const abort = new AbortController();
              req.on('close', () => abort.abort());
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                connection: 'keep-alive',
              });
              try {
                for await (const event of quickAsk.stream(sessionId, prompt, {
                  thinking: body.thinking === true,
                  search: body.search === true,
                  refFileIds: Array.isArray(body.refFileIds) ? body.refFileIds : [],
                  files: Array.isArray(body.files) ? body.files : [],
                  signal: abort.signal,
                })) {
                  res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
              } catch (error) {
                res.write(`data: ${JSON.stringify({ kind: 'error', message: String(error?.message ?? error) })}\n\n`);
              }
              res.end();
              return;
            }
            sendJson(res, 404, { ok: false, error: 'not-found' });
          } catch (error) {
            warn(`deepseek-web: route ${route} failed: ${String(error)}`);
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );
  }

  info(`deepseek-web: provider "${PROVIDER}" ready; conversations directory ${directory}`);
}

/** Show only the tail of a credential in the settings page. */
function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  if (token.length <= 8) return '****';
  return `${'*'.repeat(Math.min(token.length - 4, 12))}${token.slice(-4)}`;
}
