/**
 * Conversation import and workspace provisioning.
 *
 * The sidebar groups sessions by workspace, and a workspace is a real directory,
 * so "a hidden 对话 group" is really "a workspace whose path is this plugin's
 * conversation directory". Imported web conversations become ordinary DSH
 * sessions whose `cwd` is that directory: they then appear under the workspace,
 * fold, search, and open exactly like a native session, and keep using the
 * `deepseek-web` provider because the agent is created with that route.
 *
 * A session is seeded with the web conversation's existing turns, so opening an
 * imported conversation shows its real history rather than an empty transcript.
 *
 * @module src/sync
 */
'use strict';

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { sessionDirFor } from './store.js';
import { isQuickAskTitle } from './quick-ask-tag.js';

/** Workspace title shown in the sidebar. */
export const WORKSPACE_TITLE = '对话';

/**
 * The usable title carried by a `session/title` session event.
 *
 * The sidebar title and the web conversation title should read the same, so a
 * rename inside DSH is pushed to the web side. A title event carries the new
 * label; anything blank is ignored rather than clearing the web title.
 *
 * @param {{ type?: string, data?: { title?: unknown } } | null | undefined} event
 * @returns {string | null}
 */
export function titleFromSessionEvent(event) {
  if (event === null || event === undefined) return null;
  if (event.type !== 'session/title') return null;
  const title = event.data?.title;
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Decide whether one session event should push a title to the web side.
 *
 * A DSH session is mirrored to a web conversation through the binding ledger, so
 * a title event only means something when a binding exists for that session.
 *
 * @param {{ type?: string, data?: { title?: unknown } } | null | undefined} event
 * @param {unknown} sessionId
 * @param {(sessionId: string) => { chatSessionId?: string } | undefined} resolveBinding
 * @returns {{ chatSessionId: string, title: string } | null}
 */
export function planTitlePush(event, sessionId, resolveBinding) {
  const title = titleFromSessionEvent(event);
  if (title === null) return null;
  if (sessionId === undefined || sessionId === null) return null;
  let binding;
  try {
    binding = resolveBinding(String(sessionId));
  } catch {
    return null;
  }
  const chatSessionId = binding?.chatSessionId;
  if (typeof chatSessionId !== 'string' || chatSessionId === '') return null;
  return { chatSessionId, title };
}

/**
 * Mint the DSH session id for one imported web conversation.
 *
 * A freshly minted UUID, deliberately: the harness validates session ids, and an
 * id built from the web conversation (a bare web id, or any decorated form such
 * as `dsw-<id>`) is rejected at creation time. The two identities are kept
 * separate instead — the ledger maps `chatSessionId -> dshSessionId`.
 *
 * Minting (rather than reusing the web id) also means archiving a leftover from
 * an earlier import can never shadow a later one.
 *
 * @returns {string}
 */
export function mintSessionId() {
  return randomUUID();
}

/** Local midnight `days - 1` days before `now`, i.e. a window of `days` calendar days INCLUDING today. */
function startOfRecentDays(now, days) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/**
 * The earliest conversation timestamp (ms) a sync pass should consider.
 *
 * The default is **the last seven calendar days, today included** — the same way
 * the web product's own "last 7 days" filter reads. Two details matter:
 *
 *   - It is anchored to local midnight, not to "now minus N×24h". Running at
 *     10:00 with a `now - 7 days` cut would start at 10:00 seven days ago, which
 *     silently drops anything from that morning; midnight keeps whole days.
 *   - N means N days *counting today*. On the 23rd, "last 7 days" is the 17th
 *     through the 23rd, not the 16th.
 *
 * `'week'` is kept as a deprecated alias for the same seven-day window. It used
 * to mean "Monday 00:00 local"; mapping it here means an old config stays bounded
 * instead of falling through to the numeric branch, where `Number('week')` is NaN
 * and the whole history would be imported.
 *
 * @param {'week' | 'month' | 'all' | number | string | undefined} window
 * @param {number} [now] - epoch milliseconds, injectable for tests.
 * @returns {number} 0 when everything is in scope.
 */
export function resolveSyncWindowStart(window, now = Date.now()) {
  if (window === undefined || window === null || window === 'all') return 0;
  if (window === 'week') return startOfRecentDays(now, 7);
  if (window === 'month') {
    const date = new Date(now);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  const days = Number(window);
  if (Number.isFinite(days) && days > 0) return startOfRecentDays(now, Math.floor(days));
  return 0;
}

/**
 * The delay before the next automatic sync pass.
 *
 * A fixed cadence is the strongest "this is a timer" signal the plugin can emit:
 * a real person does not refresh a conversation list on an exact beat for hours.
 * A list request is read-only and cheap, but the *regularity* is what an abuse
 * detector can key on, so the interval is jittered around its mean.
 *
 * @param {number} baseSeconds - the configured mean interval.
 * @param {() => number} [random] - injectable so tests stay deterministic.
 * @returns {number} milliseconds to the next pass; 0 means auto-sync is off.
 */
export function nextSyncDelayMs(baseSeconds, random = Math.random) {
  const base = Number(baseSeconds);
  if (!Number.isFinite(base) || base <= 0) return 0;
  /** ±30% around the mean: breaks a fixed pattern without being erratic. */
  const JITTER = 0.3;
  const factor = 1 + (random() * 2 - 1) * JITTER;
  return Math.max(1000, Math.round(base * factor * 1000));
}

/**
 * The conversations one pass imports, ordered oldest to newest.
 *
 * Oldest-first matters: `attachSession` prepends, so importing in this order
 * leaves the most recent conversation at the top of the sidebar. Filtering by
 * the window keeps a long account from turning every pass into a full import.
 *
 * `excludeIds` carries the web conversations that already have a bound DSH
 * session. Those are conversations this plugin itself created for a new DSH
 * session, so importing them would produce a second, empty copy of the same
 * conversation — one the user never asked for.
 *
 * Quick-ask threads are excluded by their `[SideBar]` title tag: they are
 * plugin machinery, not conversations the user wrote, and the ledger does not
 * name them (a refreshed thread is a NEW web id the ledger has never seen).
 *
 * @param {ReadonlyArray<{ id: string, updatedAt: number, title?: string }>} sessions
 * @param {number} since - epoch milliseconds; 0 keeps everything.
 * @param {ReadonlySet<string>} [excludeIds] - web conversation ids already bound.
 * @returns {Array<{ id: string, updatedAt: number }>}
 */
export function selectImportBatch(sessions, since, excludeIds) {
  return sessions
    .filter((session) => (Number(session.updatedAt) || 0) * 1000 >= since)
    .filter((session) => excludeIds === undefined || !excludeIds.has(String(session.id)))
    .filter((session) => !isQuickAskTitle(session.title))
    .sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
}

/** Fragment types the web API uses. */
const THINK = 'THINK';
const RESPONSE = 'RESPONSE';

/** Output-token cap recorded in the seeded request epoch. */
export const SEED_MAX_TOKENS = 8192;
/** Context window recorded in the seeded request context. */
export const SEED_CONTEXT_WINDOW = 1_000_000;

/** Concatenate one fragment type across a message. */
function fragmentText(message, type) {
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  const parts = [];
  for (const fragment of fragments) {
    if (fragment?.type !== type) continue;
    if (typeof fragment.content === 'string' && fragment.content !== '') parts.push(fragment.content);
  }
  return parts.join('');
}

/** The user text of one web message. */
function userTextOf(message) {
  const parts = [];
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  for (const fragment of fragments) {
    if (fragment?.type === 'REQUEST' && typeof fragment.content === 'string') parts.push(fragment.content);
    else if (fragment?.type === 'FILE' && typeof fragment.content === 'string') parts.push(`[文件] ${fragment.content}`);
  }
  return parts.join('\n').trim();
}

/** Convert seconds-since-epoch to milliseconds. */
function toMillis(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return Date.now();
  return Math.round(seconds * 1000);
}

/**
 * Turn a web conversation's messages into durable session events.
 *
 * The seeded log has to look like one a live loop produced, because the
 * transcript projection, the session title, and the request epoch are all
 * derived from these events. A live session carries, in order:
 *
 *   turn/start → step/start → user/message → request/header → request/context
 *   → session/title → assistant/message → step/end → turn/end
 *
 * Omitting `step/start` leaves the assistant message outside any step (it never
 * renders), omitting `session/title` leaves the sidebar row blank, and omitting
 * `request/header`/`request/context` leaves a resumed session with no provider
 * route to call. Turns and steps are 1-based, matching the loop.
 *
 * @param {Array<object>} messages - the web conversation's history.
 * @param {{ title?: string, provider: string, model: string }} meta
 * @returns {Array<object>}
 */
export function buildSeedEvents(messages, meta) {
  const { title, provider, model } = meta;
  const events = [];
  let seq = 0;
  let turn = 0;
  let turnOpen = false;
  let headerSent = false;
  let titleSent = false;
  /** Whether the protected system head has been seeded. */
  let systemSent = false;

  /** Append one event with the next sequence number. */
  const push = (type, time, data, surfaceOp) => {
    /** @type {Record<string, unknown>} */
    const event = { type, seq: seq++, time, data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
    return seq - 1;
  };

  /**
   * Seed the protected system head, once, at the very front of the surface.
   *
   * The v4 log format expects a session's FIRST surface event to be a
   * `system/message` ("protected head"). When a later turn appends another
   * system message — the live loop does this every step — a surface that
   * started with user content has no protected head, and the reader rejects
   * the whole log as corrupt ("system/message requires a protected first
   * surface head"). Seeding one makes every subsequent append legal.
   */
  const ensureSystemHead = (time) => {
    if (systemSent) return;
    systemSent = true;
    push('system/message', time, {
      turn: 1,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'system',
        content: [{ type: 'text', text: `Imported from the DeepSeek web product. Original model: ${model}.` }],
        source: { kind: 'system-prompt' },
      },
    }, 'append');
  };

  /** Open a turn and its single step. */
  const openTurn = (time) => {
    turn += 1;
    push('turn/start', time, { turn });
    push('step/start', time, { turn, step: 1 });
    turnOpen = true;
  };

  /** Close the open step and turn. */
  const closeTurn = (time) => {
    if (!turnOpen) return;
    push('step/end', time, { turn, step: 1 });
    push('turn/end', time, { turn, reason: { kind: 'completed' } });
    turnOpen = false;
  };

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const time = toMillis(message.inserted_at);
    const role = String(message.role ?? '').toUpperCase();

    if (role === 'USER') {
      const text = userTextOf(message);
      if (text === '') continue;
      closeTurn(time);
      openTurn(time);
      ensureSystemHead(time);
      const userSeq = push('user/message', time, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }, 'append');

      // The epoch and the title are one per session, carried by the first turn.
      if (!headerSent) {
        headerSent = true;
        // `adapterDefaults` marks which values came from the adapter rather than
        // the caller, and the seed validator requires every marked key to be
        // present in `config` — so `maxTokens` is spelled out here rather than
        // left to the adapter.
        push('request/header', time, {
          header: {
            config: { provider, model, maxTokens: SEED_MAX_TOKENS },
            adapterDefaults: { maxTokens: true },
          },
          reason: 'initial',
        });
        push('request/context', time, { provider, model, contextWindow: SEED_CONTEXT_WINDOW });
      }
      if (!titleSent) {
        titleSent = true;
        const label = typeof title === 'string' && title.trim() !== '' ? title.trim() : text.slice(0, 40);
        push('session/title', time, {
          title: label,
          messageSeqs: [userSeq],
          source: { kind: 'fallback' },
        });
      }
      continue;
    }

    if (role === 'ASSISTANT') {
      const reasoning = fragmentText(message, THINK);
      const answer = fragmentText(message, RESPONSE);
      if (reasoning === '' && answer === '') continue;
      /** @type {Array<object>} */
      const content = [];
      if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning });
      if (answer !== '') content.push({ type: 'text', text: answer });
      if (!turnOpen) openTurn(time);
      push('assistant/message', time, {
        turn,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content,
          source: { kind: 'model', provider, model },
        },
        stream: [],
      }, 'append');
      closeTurn(time);
    }
  }
  if (turnOpen) closeTurn(events[events.length - 1]?.time ?? Date.now());
  return events;
}

/**
 * The tail state of a stored session log: which turn/step is still open and the
 * highest turn number seen.
 *
 * A turn that never closed is the visible trace of an append that died between
 * `turn/start` and `turn/end` (a torn process, a failed flush). The next append
 * has to close it before it can number a new turn, otherwise the log carries two
 * open turns and the transcript projection has no single current step.
 *
 * @param {ReadonlyArray<object>} events
 * @returns {{ lastTurn: number, openTurn: number | null, openStep: number | null }}
 */
function logTailState(events) {
  let lastTurn = 0;
  /** @type {number | null} */
  let openTurn = null;
  /** @type {number | null} */
  let openStep = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'turn/start') {
      const turn = Number(event.data?.turn);
      lastTurn = Number.isFinite(turn) ? Math.max(lastTurn, turn) : lastTurn + 1;
      openTurn = lastTurn;
      openStep = null;
    } else if (event.type === 'step/start') {
      openStep = Number(event.data?.step) || 1;
    } else if (event.type === 'step/end') {
      openStep = null;
    } else if (event.type === 'turn/end') {
      openTurn = null;
      openStep = null;
    }
  }
  return { lastTurn, openTurn, openStep };
}

/**
 * Turn the part of a web conversation that arrived after `afterMessageId` into
 * session events that can be APPENDED to its imported session.
 *
 * Only complete exchanges are appended. A trailing user message with no answer
 * yet (the web product is still generating, or the answer failed) is left for a
 * later pass: appending it alone would leave a turn with no assistant message,
 * and a later append cannot safely reopen that turn. Consecutive user messages
 * stop the plan for the same reason — the earlier question has no answer in the
 * log, so skipping it would silently drop content.
 *
 * `afterMessageId` must be present in `messages`; an absent anchor means the
 * history is truncated or renumbered, and appending from a guess could duplicate
 * turns that are already in the session. The caller should fall back to a full
 * re-import in that case, not append.
 *
 * Unlike {@link buildSeedEvents}, this never emits the one-per-session events
 * (`system/message`, `request/header`, `request/context`, `session/title`): the
 * imported session already carries them, and a second one would either be
 * rejected by the log validator or overwrite the epoch used by resume.
 *
 * @param {ReadonlyArray<object>} messages - the web conversation's full history.
 * @param {{
 *   afterMessageId?: number | null,
 *   startTurn?: number,
 *   baseSeq?: number,
 *   provider?: string,
 *   model?: string,
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   reason: 'no-anchor' | 'anchor-missing' | null,
 *   events: Array<object>,
 *   nextMessageId: number | null,
 *   turns: number,
 * }}
 */
export function planAppend(messages, options = {}) {
  const { afterMessageId, startTurn = 1, baseSeq = 0, provider, model } = options;
  const fail = (reason) => ({ ok: false, reason, events: [], nextMessageId: null, turns: 0 });

  if (!Array.isArray(messages)) return fail('no-anchor');
  if (afterMessageId === null || afterMessageId === undefined) return fail('no-anchor');
  const anchor = Number(afterMessageId);
  if (!Number.isFinite(anchor)) return fail('no-anchor');
  const anchorIndex = messages.findIndex((message) => Number(message?.message_id) === anchor);
  if (anchorIndex === -1) return fail('anchor-missing');

  /** @type {Array<object>} */
  const events = [];
  let seq = baseSeq;
  let turn = startTurn;
  /** The last web message id accounted for by the plan. */
  let nextMessageId = anchor;

  const push = (type, time, data, surfaceOp) => {
    /** @type {Record<string, unknown>} */
    const event = { type, seq: seq++, time, data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    events.push(event);
  };

  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object') continue;
    if (String(message.role ?? '').toUpperCase() !== 'USER') continue;
    const text = userTextOf(message);
    if (text === '') continue;

    const answer = messages[index + 1];
    if (answer === null || answer === undefined || typeof answer !== 'object') break;
    if (String(answer.role ?? '').toUpperCase() !== 'ASSISTANT') break;
    const reasoning = fragmentText(answer, THINK);
    const reply = fragmentText(answer, RESPONSE);
    if (reasoning === '' && reply === '') break;

    const askedAt = toMillis(message.inserted_at);
    const answeredAt = toMillis(answer.inserted_at);
    push('turn/start', askedAt, { turn });
    push('step/start', askedAt, { turn, step: 1 });
    // `user/message` carries the UserMessage itself, not a {turn, step, message}
    // wrapper: the event map declares it as the message, and the storage
    // validator rejects any slot whose `source` is not on the event data.
    push('user/message', askedAt, {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, 'append');

    /** @type {Array<object>} */
    const content = [];
    if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning });
    if (reply !== '') content.push({ type: 'text', text: reply });
    push('assistant/message', answeredAt, {
      turn,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        source: { kind: 'model', provider, model },
      },
      stream: [],
    }, 'append');
    push('step/end', answeredAt, { turn, step: 1 });
    push('turn/end', answeredAt, { turn, reason: { kind: 'completed' } });

    nextMessageId = Number(answer.message_id);
    turn += 1;
    index += 1;
  }

  return { ok: true, reason: null, events, nextMessageId, turns: turn - startTurn };
}

/**
 * Append a web conversation's new exchanges to the session it was imported into.
 *
 * The import path seeds a session and releases it, so the session is persisted
 * but no longer live. `sessionPersistence.open(id, 'write')` is the one public
 * door onto that log: it takes single-writer ownership, which is also the
 * concurrency gate — a session the user is looking at (or a resume in flight)
 * already owns its writer and this call fails with `AlreadyOwned`, in which case
 * the next sync pass retries.
 *
 * Appends are not routed through the agent lifecycle, so derived projections
 * (title, preview) can lag until the session is read again. The log itself is
 * the source of truth, and a turn appended here renders exactly like a live one
 * because it uses the same event vocabulary.
 *
 * @param {{
 *   persistence?: {
 *     open?: (id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }) =>
 *       Promise<{
 *         read: (offset?: number, length?: number, options?: { signal?: AbortSignal }) =>
 *           Promise<{ events: ReadonlyArray<object> }>,
 *         append: (events: ReadonlyArray<object>, options?: { signal?: AbortSignal }) => Promise<void>,
 *         flush: (options?: { signal?: AbortSignal }) => Promise<void>,
 *         close: () => Promise<void>,
 *       }>,
 *   },
 *   sessionId: string,
 *   messages: ReadonlyArray<object>,
 *   afterMessageId: number | null | undefined,
 *   provider?: string,
 *   model?: string,
 *   warn?: (message: string) => void,
 * }} options
 * @returns {Promise<{
 *   ok: boolean,
 *   reason: string | null,
 *   appended: number,
 *   nextMessageId: number | null,
 *   events: Array<object>,
 *   error: unknown,
 * }>}
 *   `reason` is one of `no-persistence`, `no-session`, `busy`, `missing`,
 *   `open-failed`, `empty-log`, `no-anchor`, `anchor-missing`, `corrupt-order`,
 *   `failed`, or `null` on success. `busy` is transient; the rest are
 *   actionable.
 */
export async function appendConversationTurns(options) {
  const { persistence, sessionId, messages, afterMessageId, provider, model, warn } = options;
  const fail = (reason, error = null) => ({
    ok: false,
    reason,
    appended: 0,
    nextMessageId: null,
    events: [],
    error,
  });

  if (typeof persistence?.open !== 'function') return fail('no-persistence');
  if (typeof sessionId !== 'string' || sessionId === '') return fail('no-session');

  let handle;
  try {
    handle = await persistence.open(sessionId, 'write');
  } catch (error) {
    const name = String(error?.name ?? '');
    const reason = name.includes('AlreadyOwned')
      ? 'busy'
      : name.includes('NotFound')
        ? 'missing'
        : 'open-failed';
    return fail(reason, error);
  }

  try {
    const read = await handle.read(0, undefined);
    const existing = Array.isArray(read?.events) ? read.events : [];
    if (existing.length === 0) return fail('empty-log');

    // A linear session's turn numbers only grow. A duplicate or a regression
    // means something else wrote turns into this log — a live agent whose
    // cached boundary was bypassed, or an older broken build. Appending on top
    // would compound the damage; the caller re-imports instead.
    let previousTurn = 0;
    for (const event of existing) {
      if (event?.type !== 'turn/start') continue;
      const turn = Number(event.data?.turn);
      if (!Number.isFinite(turn) || turn <= previousTurn) return fail('corrupt-order');
      previousTurn = turn;
    }

    const lastSeq = existing.reduce((max, event) => {
      const seq = Number(event?.seq);
      return Number.isFinite(seq) ? Math.max(max, seq) : max;
    }, -1);
    const tail = logTailState(existing);

    let seq = lastSeq + 1;
    /** @type {Array<object>} */
    const closers = [];
    const closeAt = Date.now();
    if (tail.openTurn !== null) {
      if (tail.openStep !== null) {
        closers.push({ type: 'step/end', seq: seq++, time: closeAt, data: { turn: tail.openTurn, step: tail.openStep } });
      }
      closers.push({
        type: 'turn/end',
        seq: seq++,
        time: closeAt,
        data: { turn: tail.openTurn, reason: { kind: 'interrupted' } },
      });
    }

    const plan = planAppend(messages, {
      afterMessageId,
      startTurn: tail.lastTurn + 1,
      baseSeq: seq,
      provider,
      model,
    });
    if (!plan.ok) return fail(plan.reason);

    const events = [...closers, ...plan.events];
    if (events.length === 0) {
      return {
        ok: true,
        reason: 'no-new-messages',
        appended: 0,
        nextMessageId: Number.isFinite(Number(afterMessageId)) ? Number(afterMessageId) : null,
        events,
        error: null,
      };
    }

    await handle.append(events);
    await handle.flush();
    // A write handle reads its own appends and validates every stored record.
    // Doing that here turns a malformed event shape into a reported append
    // failure instead of a log that the NEXT open refuses as corrupt.
    await handle.read(0, undefined);
    if (plan.events.length === 0) {
      // The only work was closing a torn turn; report it as a repair, not as
      // content that arrived.
      return {
        ok: true,
        reason: 'repaired',
        appended: 0,
        nextMessageId: Number.isFinite(Number(afterMessageId)) ? Number(afterMessageId) : null,
        events,
        error: null,
      };
    }
    return {
      ok: true,
      reason: null,
      appended: plan.turns,
      nextMessageId: plan.nextMessageId,
      events,
      error: null,
    };
  } catch (error) {
    warn?.(`deepseek-web: appending to session ${sessionId} failed: ${String(error)}`);
    return fail('failed', error);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      warn?.(`deepseek-web: closing the write handle for ${sessionId} failed: ${String(error)}`);
    }
  }
}

/**
 * The last message id of a web conversation, which is the parent a new turn
 * must attach to.
 *
 * @param {Array<object>} messages
 * @returns {number | null}
 */
export function lastMessageId(messages) {
  let last = null;
  for (const message of messages) {
    const id = Number(message?.message_id);
    if (Number.isFinite(id)) last = id;
  }
  return last;
}

/**
 * Resolve (or create) the workspace that holds imported conversations.
 *
 * @param {{ workspaceRegistry: any }} services
 * @param {string} directory
 * @param {(message: string) => void} warn
 * @returns {Promise<{ workspaceId: string | null, workspace: any, error: string | null }>}
 */
export async function ensureWorkspace(services, directory, warn) {
  const registry = services.workspaceRegistry;
  if (registry === undefined) {
    const error = 'no workspaceRegistry in this composition';
    warn(`deepseek-web: ${error}; conversations will not appear grouped`);
    return { workspaceId: null, workspace: null, error };
  }
  // Resolve by path first: `list()` validates every session of every workspace,
  // so one unreadable session would abort the whole pass and stop the workspace
  // from ever being created.
  try {
    if (typeof registry.resolveByPath === 'function') {
      const existing = await registry.resolveByPath(directory);
      if (existing !== undefined && existing !== null) {
        return { workspaceId: String(existing.id), workspace: existing, error: null };
      }
    }
  } catch (error) {
    warn(`deepseek-web: workspace resolveByPath failed: ${String(error)}`);
  }
  try {
    const created = await registry.create(directory, WORKSPACE_TITLE);
    return { workspaceId: String(created.id), workspace: created, error: null };
  } catch (error) {
    // A concurrent create may have won the race; re-resolve once before giving up.
    try {
      const existing = await registry.resolveByPath?.(directory);
      if (existing !== undefined && existing !== null) {
        return { workspaceId: String(existing.id), workspace: existing, error: null };
      }
    } catch {
      /* fall through to the original error */
    }
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    warn(`deepseek-web: could not provision the ${WORKSPACE_TITLE} workspace: ${detail}`);
    return { workspaceId: null, error: detail };
  }
}

/**
 * Attach imported sessions to the workspace that owns their directory.
 *
 * Creating a workspace does NOT adopt the sessions already sitting in its
 * directory: membership is an explicit record on the workspace, validated
 * against each session's stored `cwd`. Without this pass the workspace renders
 * empty and every imported session stays in the ungrouped bucket.
 *
 * @param {any} workspace - the workspace entity returned by the registry.
 * @param {readonly string[]} sessionIds
 * @param {(message: string) => void} warn
 * @returns {Promise<{ attached: number, failed: number, errors: string[] }>}
 */
export async function attachSessions(workspace, sessionIds, warn) {
  const result = { attached: 0, failed: 0, errors: [] };
  if (workspace === null || workspace === undefined || typeof workspace.attachSession !== 'function') {
    if (sessionIds.length > 0) {
      const detail = 'workspace has no attachSession; sessions stay ungrouped';
      warn(`deepseek-web: ${detail}`);
      result.failed = sessionIds.length;
      result.errors.push(detail);
    }
    return result;
  }
  for (const sessionId of sessionIds) {
    try {
      await workspace.attachSession(sessionId);
      result.attached += 1;
    } catch (error) {
      result.failed += 1;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (result.errors.length < 3) result.errors.push(`${sessionId}: ${detail}`);
      warn(`deepseek-web: could not attach ${sessionId} to the workspace: ${detail}`);
    }
  }
  return result;
}

/**
 * Create one seeded session for an imported conversation and release it.
 *
 * `agentLoop.createAgent` is the only creation path that attaches the session-log
 * writer, so it is what makes the imported transcript durable — but "durable" is
 * buffered. Disposing straight away can release the session before its log has
 * reached storage, and the sidebar renders a row from the session query index,
 * which only sees persisted sessions. That is the difference between "the
 * conversation is there after a reload" and "it is there immediately": the
 * explicit `sessions.flush` below forces the log out while the session is still
 * live, so the index picks it up in the same pass.
 *
 * @param {object} options
 * @param {any} options.ctx - the plugin context that owns the lifecycle.
 * @param {any} options.agentLoop
 * @param {string} options.sessionId
 * @param {string} options.cwd
 * @param {Array<object>} options.seed
 * @param {string} options.provider
 * @param {string} options.model
 * @param {(message: string) => void} options.warn
 * @returns {Promise<{ ok: boolean, error: string | null }>}
 */
export async function createSeededSession(options) {
  const { ctx, agentLoop, sessionId, cwd, seed, provider, model, warn } = options;
  if (agentLoop?.createAgent === undefined) {
    const error = 'no agentLoop in this composition';
    warn(`deepseek-web: ${error}; cannot import conversations`);
    return { ok: false, error };
  }
  try {
    const handle = await agentLoop.createAgent(ctx, {
      sessionId,
      meta: { cwd },
      seed,
      agentOptions: { provider, model },
    });

    // Flush while the session is still live: `sessions.flush` needs the live
    // session object, and once disposed only the buffered write remains.
    const sessions = ctx.get('sessions');
    if (typeof sessions?.flush === 'function') {
      const live = sessions.get?.(sessionId);
      if (live !== undefined) {
        try {
          await sessions.flush(live);
        } catch (error) {
          warn(`deepseek-web: could not flush session ${sessionId} before release: ${String(error)}`);
        }
      }
    }

    try {
      await handle.dispose();
    } catch (error) {
      warn(`deepseek-web: disposing a seeded session failed: ${String(error)}`);
    }
    return { ok: true, error: null };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    warn(`deepseek-web: could not create session ${sessionId}: ${detail}`);
    return { ok: false, error: detail };
  }
}

/**
 * Where a bound session came from.
 *
 * `origin` is written once and never changed. `seeded` cannot answer this: the
 * adapter flips it to `true` after the first completed reply, so a conversation
 * started in DSH and then used becomes indistinguishable from an import.
 *
 * Bindings written before `origin` existed carry no provenance. They are treated
 * as undeletable: deleting a conversation the user wrote is irreversible, while
 * leaving a file behind is merely untidy and can be cleaned up by hand.
 *
 * @param {string} sessionId
 * @param {Record<string, { origin?: string }> | undefined} bindings
 * @returns {'imported' | 'local' | 'unknown'}
 */
function originOf(sessionId, bindings) {
  if (bindings === undefined || bindings === null) return 'unknown';
  const binding = bindings[sessionId];
  if (binding === undefined) return 'unknown';
  if (binding.origin === 'imported') return 'imported';
  if (binding.origin === 'local') return 'local';
  return 'unknown';
}

/**
 * Undo one import: archive this plugin's sessions, remove the imported ones'
 * files and the workspace, and leave the credential alone.
 *
 * Two things drive the design.
 *
 * **Archive before deleting.** Deleting a session's files does not remove it from
 * the process-local session index, so the sidebar keeps listing it — just no
 * longer grouped, which looks like the undo only made a mess instead of cleaning
 * one up. Archiving is the one supported way to tell the runtime "stop listing
 * this", and it reads each session's stored header to do so; once the files are
 * gone that call fails. So: archive while the files are still there.
 *
 * **Archive by directory, not just by ledger.** A conversation STARTED inside DSH
 * with the web model also lives under this plugin's directory, but it has no
 * import record — the ledger only tracks web conversations pulled in FROM the
 * web side. Undoing by ledger alone therefore leaves those sessions behind, and
 * because their `cwd` still points at the now-unregistered directory they land in
 * the ungrouped bucket. So every session found under the directory is archived;
 * only the ledger's own sessions have their files removed, since a conversation
 * the user started in DSH is still theirs.
 *
 * Archived ids stay in the registry's archive set. That is harmless because every
 * imported conversation gets a freshly minted session id, so a later import can
 * never collide with an archived leftover.
 *
 * @param {{
 *   imported: Record<string, { dshSessionId: string }>,
 *   workspaceId: string | null,
 *   directory: string,
 *   registry: any,
 *   query?: any,
 *   bindings?: Record<string, { seeded?: boolean }>,
 *   warn: (message: string) => void,
 * }} options
 * @returns {Promise<{
 *   archivedSessions: number, archiveFailed: number, archivedLocal: number,
 *   keptLocal: number, keptUnknown: number, keptArchiveFailed: number,
 *   removedSessions: number, failedSessions: number, failedSessionIds: string[],
 *   workspaceDeleted: boolean, workspaceError: string | null,
 * }>}
 */
export async function undoImports(options) {
  const { imported, workspaceId, directory, registry, query, bindings, warn } = options;
  const report = {
    archivedSessions: 0,
    archiveFailed: 0,
    archivedLocal: 0,
    keptLocal: 0,
    /** Ledger entries whose provenance predates `origin`; logs deliberately kept. */
    keptUnknown: 0,
    /** Ledger entries whose log survived because archiving failed. */
    keptArchiveFailed: 0,
    removedSessions: 0,
    failedSessions: 0,
    /** Ledger session ids that could not be archived or deleted. */
    failedSessionIds: [],
    workspaceDeleted: false,
    workspaceError: null,
  };
  /** @type {Set<string>} */
  const failedIds = new Set();

  /** Sessions this plugin imported from the web side. */
  const ledgerSessionIds = [];
  for (const entry of Object.values(imported)) {
    const sessionId = entry?.dshSessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      report.failedSessions += 1;
      continue;
    }
    ledgerSessionIds.push(sessionId);
  }
  const ledgerSet = new Set(ledgerSessionIds);

  // Everything under the directory, ledger or not. A session started in DSH is
  // local to the user, so it is archived but its log is kept.
  const allSessionIds = new Set(ledgerSessionIds);
  if (typeof query?.filterSessions === 'function') {
    try {
      const records = await query.filterSessions([{ kind: 'cwd', values: [directory] }]);
      for (const record of records) {
        const id = record?.header?.id;
        if (typeof id === 'string' && id !== '') allSessionIds.add(id);
      }
    } catch (error) {
      warn(`deepseek-web: could not list sessions under ${directory}: ${String(error)}`);
    }
  } else if (ledgerSessionIds.length > 0) {
    warn('deepseek-web: no sessionQuery; undo can only see sessions it imported, so conversations started in DSH may remain ungrouped');
  }

  // 1. Archive while the logs still exist.
  if (registry?.archiveSession === undefined) {
    report.archiveFailed = allSessionIds.size;
    // Nothing can be stopped, so nothing may be deleted: the log is the only
    // remaining copy of a conversation the user wrote, and an unarchived session
    // might still be live. Report it instead of quietly destroying data.
    for (const sessionId of allSessionIds) failedIds.add(sessionId);
    if (allSessionIds.size > 0) {
      warn('deepseek-web: no workspaceRegistry.archiveSession; undo can only report, so the sessions and their logs are kept');
    }
  } else {
    for (const sessionId of allSessionIds) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
        report.archivedSessions += 1;
        // "Started here" and "provenance unknown" are counted separately: the page
        // explains each of them in its own sentence, and counting an unknown one as
        // local would have the same session described twice, in two different ways.
        if (!ledgerSet.has(sessionId) || originOf(sessionId, bindings) === 'local') report.archivedLocal += 1;
      } catch (error) {
        report.archiveFailed += 1;
        if (ledgerSet.has(sessionId)) failedIds.add(sessionId);
        warn(`deepseek-web: could not archive ${sessionId} before removal: ${String(error)}`);
      }
    }
  }

  // 2. Then drop the files of the sessions this plugin IMPORTED.
  //
  // Three reasons a ledger entry keeps its log:
  //
  //   - its provenance says the conversation started here;
  //   - provenance is unknown (written before `origin` existed) — deleting what
  //     the user wrote cannot be undone, while a leftover file can;
  //   - archiving failed, which means the session may still be live. Removing the
  //     file would pull it out from under a running session and destroy the only
  //     copy an archive retry would need.
  for (const sessionId of ledgerSessionIds) {
    const origin = originOf(sessionId, bindings);
    if (origin !== 'imported') {
      report.keptLocal += 1;
      if (origin === 'unknown') report.keptUnknown += 1;
      continue;
    }
    if (failedIds.has(sessionId)) {
      report.keptArchiveFailed += 1;
      continue;
    }
    try {
      await rm(sessionDirFor(sessionId, directory), { recursive: true, force: true });
      report.removedSessions += 1;
    } catch (error) {
      report.failedSessions += 1;
      failedIds.add(sessionId);
      warn(`deepseek-web: could not remove session ${sessionId}: ${String(error)}`);
    }
  }

  // 3. Finally the workspace registration.
  if (workspaceId !== null && workspaceId !== undefined) {
    if (registry?.delete === undefined) {
      report.workspaceError = 'no workspaceRegistry.delete in this composition';
    } else {
      try {
        await registry.delete(workspaceId);
        report.workspaceDeleted = true;
      } catch (error) {
        report.workspaceError = error instanceof Error ? error.message : String(error);
        warn(`deepseek-web: could not delete the workspace: ${report.workspaceError}`);
      }
    }
  }

  report.failedSessionIds = [...failedIds];
  return report;
}
