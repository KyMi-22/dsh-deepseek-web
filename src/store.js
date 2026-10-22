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
  /** @param {PluginState} state */
  constructor(state) {
    this.state = state;
    /** @type {Promise<void>} */
    this.queue = Promise.resolve();
    /** Message of the most recent background write failure, if any. */
    this.lastWriteError = null;
  }

  static async open() {
    return new StateStore(await loadState());
  }

  /** Current token. */
  get token() {
    return this.state.token;
  }

  /**
   * Persist the current snapshot, coalescing concurrent writes.
   *
   * The queue must survive a failed write (a transient disk error on the first
   * call must not wedge every later call), but the caller must still learn that
   * THIS write failed. Swallowing the rejection made `setToken` report success
   * while nothing reached the disk, so a restart silently restored the old
   * credential. The internal queue therefore keeps a recovered promise, and the
   * rejection is delivered to the caller separately.
   *
   * @returns {Promise<void>} rejects when this snapshot failed to persist.
   */
  flush() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    const write = this.queue.then(() => saveState(snapshot));
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
   * The in-memory value is rolled back when persistence fails: leaving the
   * candidate token resident would let a later, successful flush write it out, so
   * the running client and the next launch would disagree about which credential
   * is configured.
   *
   * @param {string} token
   * @returns {Promise<void>} rejects when the new value could not be persisted.
   */
  async setToken(token) {
    const previous = this.state.token;
    this.state.token = token;
    try {
      await this.flush();
    } catch (error) {
      this.state.token = previous;
      throw error;
    }
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

  /** @param {string} sessionId */
  importedBySession(sessionId) {
    return this.state.imported[sessionId];
  }

  /** @param {ImportedConversation} entry */
  recordImported(entry) {
    this.state.imported[entry.chatSessionId] = entry;
    this.flushSoon();
  }
}
