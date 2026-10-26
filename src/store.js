/**
 * Plugin-owned durable state.
 *
 * The harness config file is the right home for deployment settings, but this
 * plugin also carries a credential and a growing conversation map that the user
 * edits from the settings page, so it keeps one small JSON document under the
 * harness home instead. Every write goes through an atomic temp-file rename so a
 * crash cannot leave a half-written map behind.
 *
 * @module src/store
 */
'use strict';

import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** Directory name under the harness home. */
const DATA_DIR = 'deepseek-web';
/** State file name. */
const STATE_FILE = 'state.json';

/**
 * The harness home. `DSH_HOME` wins when a launcher sets it; otherwise the
 * documented per-user location.
 */
export function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/** The directory this plugin owns. */
export function dataDir() {
  return join(resolveHome(), DATA_DIR);
}

/** Absolute path of the state document. */
export function stateFile() {
  return join(dataDir(), STATE_FILE);
}

/**
 * The directory that backs the "对话" workspace.
 *
 * A workspace must point at an existing directory, and this one deliberately
 * holds no working files: it exists so the workspace browser has a real path to
 * group the imported conversations under.
 */
export function conversationDir() {
  return join(dataDir(), 'conversations');
}

/**
 * The directory the session store keeps one session in.
 *
 * The store buckets sessions by their `cwd` under a slug built from that path:
 * every run of `:` `/` or `\` collapses to a single `-`, wrapped in `--`. This
 * is what lets an undo delete exactly the sessions this plugin imported.
 *
 * The result is used as the target of a recursive delete, so the id is validated
 * and the resolved path is proven to stay inside the session root. An id reaching
 * here comes from this plugin's own ledger or from a session listing, but the
 * ledger is a plain JSON file on disk: a tampered `../` must not be able to turn
 * an undo into "delete something else".
 *
 * @param {string} sessionId
 * @param {string} cwd
 */
export function sessionDirFor(sessionId, cwd) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionId) || sessionId.includes('..')) {
    throw new TypeError('refusing to build a session directory from an unusable session id');
  }
  const slug = `--${cwd.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`;
  const sessionRoot = join(resolveHome(), 'sessions');
  const target = join(sessionRoot, slug, sessionId);
  const resolvedRoot = resolve(sessionRoot);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new TypeError('refusing to build a session directory outside the session store');
  }
  return target;
}

/**
 * @typedef {object} SessionBinding
 * @property {string} chatSessionId
 * @property {number | null} parentMessageId
 * @property {boolean} seeded
 */

/**
 * @typedef {object} ImportedConversation
 * @property {string} chatSessionId
 * @property {string} dshSessionId
 * @property {number} updatedAt
 * @property {number} messageCount
 */

/**
 * @typedef {object} PluginState
 * @property {string} token
 * @property {string} deviceId
 * @property {Record<string, SessionBinding>} bindings
 * @property {Record<string, ImportedConversation>} imported
 * @property {string | null} workspaceId
 * @property {number} lastSyncAt
 * @property {number} syncPausedUntil - background sync stays off until this time
 * @property {string | null} lastSyncError - why the last per-conversation import failed
 * @property {string | null} lastWorkspaceError - why grouping or provisioning failed
 * @property {object | null} lastReport - the last sync report, kept for diagnosis
 * @property {Record<string, import('./quick-ask.js').QuickAskThread>} quickAsk
 *   quick-ask side threads, keyed by the DSH session id they serve
 */

/** Empty state with a stable random device id. */
function emptyState() {
  return {
    token: '',
    deviceId: `dsh-web-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    bindings: {},
    imported: {},
    workspaceId: null,
    lastSyncAt: 0,
    syncPausedUntil: 0,
    lastSyncError: null,
    lastWorkspaceError: null,
    lastReport: null,
    quickAsk: {},
  };
}

/** Read the state document, repairing anything missing with defaults. */
export async function loadState() {
  const file = stateFile();
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  const base = emptyState();
  if (parsed === null || typeof parsed !== 'object') return base;
  return {
    token: typeof parsed.token === 'string' ? parsed.token : base.token,
    deviceId: typeof parsed.deviceId === 'string' && parsed.deviceId !== '' ? parsed.deviceId : base.deviceId,
    bindings: parsed.bindings !== null && typeof parsed.bindings === 'object' ? parsed.bindings : {},
    imported: parsed.imported !== null && typeof parsed.imported === 'object' ? parsed.imported : {},
    workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : null,
    lastSyncAt: Number(parsed.lastSyncAt) || 0,
    syncPausedUntil: Number(parsed.syncPausedUntil) || 0,
    lastSyncError: typeof parsed.lastSyncError === 'string' ? parsed.lastSyncError : null,
    lastWorkspaceError: typeof parsed.lastWorkspaceError === 'string' ? parsed.lastWorkspaceError : null,
    lastReport: parsed.lastReport !== null && typeof parsed.lastReport === 'object' ? parsed.lastReport : null,
    quickAsk: parsed.quickAsk !== null && typeof parsed.quickAsk === 'object' ? parsed.quickAsk : {},
  };
}

/**
 * Write the state document atomically.
 *
 * The document holds the web credential in plaintext, so the directory and the
 * file are created owner-only (`0700` / `0600`). On Windows the mode bits only
 * govern the read-only flag, but the ACL there is already per-user; on
 * POSIX this is the difference between "only I can read my token" and "any user
 * on this machine can".
 */
export async function saveState(state) {
  const file = stateFile();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
  // `mode` on write only applies when the file is created; an older state file
  // keeps whatever permissions it was written with. Tighten explicitly so an
  // upgraded install also stops exposing a previously world-readable token.
  try {
    await chmod(file, 0o600);
  } catch {
    /* Windows may not model this; the directory ACL still governs access */
  }
}

/**
 * Ensure the directory that backs the conversations workspace exists.
 *
 * Returns the CANONICAL path: a workspace registers its own canonical
 * (`realpath`) spelling and matches sessions by comparing their stored `cwd`
 * against it, so sessions must be created with the same canonical string or they
 * silently fail to group.
 */
export async function ensureConversationDir() {
  const dir = conversationDir();
  await mkdir(dir, { recursive: true });
  try {
    return await realpath(dir);
  } catch {
    return dir;
  }
}

/**
 * An in-memory view of the state with write-through persistence.
 *
 * The adapter reads it synchronously on every turn, which is why the map is kept
 * in memory and only the persistence is asynchronous.
 */
export class StateStore {
  /**
   * @param {PluginState} state
   * @param {{ persist?: (state: PluginState) => Promise<void> }} [options]
   *   `persist` is injectable so tests can control write success and ordering
   *   deterministically instead of provoking filesystem errors.
   */
  constructor(state, options = {}) {
    this.state = state;
    /** The write function; real filesystem unless a test supplied its own. */
    this.persist = typeof options.persist === 'function' ? options.persist : saveState;
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
    /** Message of the most recent background write failure, if any. */
    this.lastWriteError = null;
    /**
     * The credential the disk currently holds. On construction that is whatever
     * was loaded, so it always starts in agreement with storage.
     *
     * @type {string}
     */
    this.committedToken = state.token ?? '';
    /**
     * Set while a credential replacement owns the store.
     *
     * A token save is read-modify-write on shared state: it sets a candidate,
     * persists, and rolls back on failure. A background write queued in that
     * window would otherwise snapshot the candidate and commit it later — even
     * after the save was rejected and rolled back.
     *
     * @type {boolean}
     */
    this.tokenCommitInFlight = false;
    /**
     * Serializes credential replacement end to end (see `tokenCommitInFlight`).
     *
     * @type {Promise<void>}
     */
    this.tokenQueue = Promise.resolve();
  }

  static async open() {
    return new StateStore(await loadState());
  }

  /** Current token. */
  get token() {
    return this.state.token;
  }

  /**
   * Persist the current state.
   *
   * Two rules that are easy to get wrong:
   *
   * 1. The snapshot is taken when the write RUNS, not when it is queued. A queued
   *    write that snapshotted eagerly would capture whatever the state looked like
   *    at call time — including a credential candidate that is rolled back later.
   *
   * 2. While a credential save is in flight, `state.token` holds a candidate that
   *    has not been accepted. Such a write persists `committedToken` instead, so a
   *    background write (a binding, a ledger row) can never smuggle a rejected
   *    token onto disk.
   *
   * The queue must survive a failed write (a transient error must not wedge every
   * later call), but the caller must still learn that THIS write failed: swallowing
   * it once made `setToken` report success while nothing reached the disk.
   *
   * @returns {Promise<void>} rejects when this write failed to persist.
   */
  flush() {
    return this.enqueue(false);
  }

  /**
   * Queue one write. `includeCandidate` is only true for the credential save
   * itself, which is the one write allowed to commit an uncommitted token.
   *
   * @param {boolean} includeCandidate
   * @returns {Promise<void>}
   */
  enqueue(includeCandidate) {
    const write = this.queue.then(async () => {
      const snapshot = JSON.parse(JSON.stringify(this.state));
      if (this.tokenCommitInFlight && !includeCandidate) snapshot.token = this.committedToken;
      await this.persist(snapshot);
      if (includeCandidate) this.committedToken = snapshot.token;
    });
    // Keep the queue alive after a failure so the next flush still runs.
    this.queue = write.catch(() => undefined);
    return write;
  }

  /**
   * Fire-and-forget flush for background bookkeeping.
   *
   * These writes (a binding, a ledger row) are not user-visible confirmations, so
   * a failure must not reject into an event handler; it is recorded on the store
   * instead, where the settings page can surface it.
   */
  flushSoon() {
    this.flush()
      .then(() => {
        // A later success means the disk is reachable again; a stale error would
        // keep telling the user their state is not being saved.
        this.lastWriteError = null;
      })
      .catch((error) => {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
      });
  }

  /**
   * Replace the credential.
   *
   * The whole transaction is serialized. `flush` already orders writes, but a
   * rollback mutates in-memory state: without this queue, save A failing could
   * restore its snapshot *after* save B had written the newer value, leaving the
   * disk on B and memory on A's predecessor — and the next launch would disagree
   * with the running client.
   *
   * @param {string} token
   * @returns {Promise<void>} rejects when the new value could not be persisted.
   */
  async setToken(token) {
    const run = this.tokenQueue.then(async () => {
      const previous = this.committedToken;
      this.tokenCommitInFlight = true;
      this.state.token = token;
      try {
        // The credential save is the one write allowed to commit the candidate.
        await this.enqueue(true);
        this.tokenCommitInFlight = false;
      } catch (error) {
        // Restore what the disk actually holds, not what memory held a moment ago:
        // another writer may have moved `committedToken` in between.
        this.state.token = this.committedToken;
        this.tokenCommitInFlight = false;
        throw error;
      }
    });
    // The queue must survive a rejection so the next save still runs.
    this.tokenQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @param {string} sessionId */
  binding(sessionId) {
    return this.state.bindings[sessionId];
  }

  /**
   * @param {string} sessionId
   * @param {SessionBinding} binding
   */
  setBinding(sessionId, binding) {
    this.state.bindings[sessionId] = binding;
    this.flushSoon();
  }

  /** @param {ImportedConversation} entry */
  recordImported(entry) {
    this.state.imported[entry.chatSessionId] = entry;
    this.flushSoon();
  }
}
