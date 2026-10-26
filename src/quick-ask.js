/**
 * Quick-ask side panel: the host half.
 *
 * A "quick ask" is a throwaway question about the CURRENT conversation that is
 * answered on the DeepSeek web product without touching the conversation
 * itself. The panel lives in the right sidebar (registered by `client.js`);
 * this module owns everything the panel talks to:
 *
 *   - building the compressed context from a session's stored log
 *   - one web thread per DSH session (created on first use, then reused)
 *   - streaming replies back to the panel over SSE
 *
 * Nothing here appends to the DSH session log, so the conversation's context
 * window never grows because of a quick ask. The exchange history lives in
 * `state.json` under `quickAsk` (one record per DSH session id), which is what
 * lets the panel reopen with its transcript after a reload.
 *
 * @module src/quick-ask
 */
'use strict';

import { isHumanMessage, isHarnessInjection, mediaTypeForName } from './adapter.js';
import { extractSessionTitle, quickAskTitle } from './quick-ask-tag.js';

export { QUICK_ASK_FALLBACK_TITLE, QUICK_ASK_TAG, extractSessionTitle, isQuickAskTitle, quickAskTitle } from './quick-ask-tag.js';

/** How many code units one turn may contribute before it is truncated. */
const MAX_TURN_CHARS = 1600;

/** Total budget for the compressed context, in code units. */
const MAX_CONTEXT_CHARS = 12000;

/** How many exchanges (user+assistant pairs) the transcript keeps per thread. */
const MAX_STORED_EXCHANGES = 50;

/** Characters of one stored exchange kept in the transcript record. */
const MAX_STORED_CHARS = 8000;

/**
 * Flatten one session-log content field into plain text.
 *
 * Mirrors the adapter's prompt flattening: text blocks joined, reasoning and
 * tool calls dropped, file attachments rendered as a placeholder.
 *
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'file') parts.push('[文件]');
  }
  return parts.join('\n').trim();
}

/** Clip one turn's text to the per-turn budget, keeping its head and a marker. */
function clip(text, budget = MAX_TURN_CHARS) {
  const body = String(text).replace(/\s+/gu, ' ').trim();
  return body.length > budget ? `${body.slice(0, budget)}…` : body;
}

/**
 * Extract the human-typed turns of a session as an ordered exchange list.
 *
 * Reads the session's stored log (v4 events), keeps `user/message` events that
 * a human actually typed (`source.kind === 'user'`, not harness bookkeeping)
 * and the `assistant/message` replies that settled after them. Reasoning
 * blocks, tool traffic, and injected stanzas never reach the web thread.
 *
 * @param {ReadonlyArray<object>} events - session-log events in seq order
 * @returns {Array<{ role: 'user' | 'assistant', text: string }>}
 */
export function extractExchanges(events) {
  const turns = [];
  /** Index of the open user turn; `-1` when the last user turn was answered. */
  let openUser = -1;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const type = event.type;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;

    if (type === 'user/message') {
      const message = data.message ?? data;
      if (!isHumanMessage(message)) continue;
      const text = contentToText(message.content);
      if (text === '' || isHarnessInjection(text)) continue;
      turns.push({ role: 'user', text });
      openUser = turns.length - 1;
      continue;
    }

    if (type === 'assistant/message') {
      const message = data.message;
      if (message === null || typeof message !== 'object') continue;
      const text = contentToText(message.content);
      if (text === '') continue;
      turns.push({ role: 'assistant', text });
      openUser = -1;
      continue;
    }
    void openUser;
  }
  return turns;
}

/**
 * Compress extracted exchanges into the context primer sent to the web thread.
 *
 * Deterministic rule-based compression: the NEWEST turns are kept whole (up to
 * the budget, newest first), older turns are summarized away entirely. A user
 * turn always precedes its assistant reply in the output, so the web model
 * reads a coherent transcript.
 *
 * @param {ReadonlyArray<{ role: 'user' | 'assistant', text: string }>} exchanges
 * @returns {string} the primer text; empty when there is nothing to send
 */
export function compressExchanges(exchanges) {
  const kept = [];
  let budget = MAX_CONTEXT_CHARS;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const turn = exchanges[i];
    const line = `${turn.role === 'user' ? '用户' : '助手'}：${clip(turn.text)}`;
    if (kept.length > 0 && line.length > budget) break;
    kept.push(line);
    budget -= line.length;
    if (budget <= 0) break;
  }
  if (kept.length === 0) return '';
  const ordered = kept.reverse();
  if (kept.length < exchanges.length) {
    ordered.unshift(`（更早的 ${exchanges.length - kept.length} 轮已省略）`);
  }
  return ordered.join('\n');
}

/** The text sent as the FIRST message of a fresh quick-ask thread. */
export function contextPrimer(context) {
  return [
    '你是一个「快捷侧问」助手。用户正在另一个对话里工作，下面是该对话的背景（可能已压缩）。',
    '之后用户会就这个背景提一些小问题；请直接回答，不要复述背景。',
    '--- 背景开始 ---',
    context,
    '--- 背景结束 ---',
  ].join('\n');
}

/**
 * Read one session's stored log through the session-persistence service.
 *
 * Returns the raw event array (possibly empty); `null` when the session has no
 * stored log at all. A missing service or a read error is the caller's to
 * report — a quick ask must never break the conversation it observes.
 *
 * @param {{ open?: (id: string, mode: string, options?: { signal?: AbortSignal }) => Promise<{ read: (offset?: number, length?: number, options?: { signal?: AbortSignal }) => Promise<{ events: object[] }>, close: () => Promise<void> }> }} persistence
 * @param {string} sessionId
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object[] | null>}
 */
export async function readSessionEvents(persistence, sessionId, options = {}) {
  if (persistence?.open !== undefined) {
    let handle;
    try {
      handle = await persistence.open(sessionId, 'read', { signal: options.signal });
    } catch {
      return null;
    }
    try {
      const { events } = await handle.read(0, undefined, { signal: options.signal });
      return events;
    } finally {
      try {
        await handle.close();
      } catch {
        /* a read handle that fails to release must not fail the request */
      }
    }
  }
  return null;
}

/** Clip one stored exchange so the transcript record stays bounded. */
function clipStored(text) {
  const body = String(text);
  return body.length > MAX_STORED_CHARS ? `${body.slice(0, MAX_STORED_CHARS)}…` : body;
}

/**
 * The per-session quick-ask record kept in `state.json`.
 *
 * @typedef {object} QuickAskThread
 * @property {string} chatSessionId - the web conversation id
 * @property {number | null} parentMessageId - tail message id for continuation
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} contextSent - the primer the thread was seeded with
 * @property {string} [sessionTitle] - the DSH conversation title the thread is named after
 * @property {boolean} [titled] - whether the `SideBar：` tag rename landed
 * @property {Array<{ role: 'user' | 'assistant', text: string, at?: number }>} exchanges
 */

/**
 * The quick-ask controller: one instance per plugin mount.
 *
 * The panel routes call into here; the controller owns thread creation, the
 * per-session in-flight lock, and the SSE pump that turns the web stream into
 * panel events. Transcript updates are written through the plugin's state
 * store, so they survive a reload.
 */
export class QuickAsk {
  /**
   * @param {{
   *   api: import('./api.js').DeepSeekWebApi,
   *   store: { state: { quickAsk?: Record<string, QuickAskThread> }, flush: () => Promise<void> },
   *   persistence: () => unknown,
   *   warn?: (message: string) => void,
   * }} deps
   */
  constructor(deps) {
    this.api = deps.api;
    this.store = deps.store;
    this.persistence = deps.persistence;
    this.warn = deps.warn ?? (() => {});
    if (this.store.state.quickAsk === null || typeof this.store.state.quickAsk !== 'object') {
      this.store.state.quickAsk = {};
    }
    /** @type {Map<string, Promise<QuickAskThread>>} thread creation locks */
    this.creating = new Map();
    /** @type {Set<string>} sessions with a stream in flight */
    this.streaming = new Set();
  }

  /**
   * The thread record for one DSH session, if any.
   * @param {string} sessionId
   */
  threadOf(sessionId) {
    const thread = this.store.state.quickAsk?.[sessionId];
    return thread !== null && typeof thread === 'object' ? thread : undefined;
  }

  /**
   * Status the panel renders on open: whether a thread exists, its transcript,
   * and whether the panel can work at all (credential + persistence).
   *
   * @param {string} sessionId
   */
  async status(sessionId) {
    const thread = this.threadOf(sessionId);
    const persistence = this.persistence();
    return {
      ok: true,
      hasThread: thread !== undefined,
      ready: this.api.ready,
      streaming: this.streaming.has(sessionId),
      exchanges: thread !== undefined ? thread.exchanges.map((row) => ({ ...row })) : [],
      contextChars: thread !== undefined ? thread.contextSent.length : 0,
      canRefresh: persistence?.open !== undefined,
    };
  }

  /**
   * Ensure the session has a web thread seeded with the compressed context.
   *
   * Creation is serialized per session: two racing panel opens must not mint
   * two web conversations. An existing thread is returned untouched — the
   * "refresh" route is the only thing that replaces a thread.
   *
   * @param {string} sessionId
   * @returns {Promise<QuickAskThread>}
   */
  async ensureThread(sessionId) {
    const existing = this.threadOf(sessionId);
    if (existing !== undefined) return existing;
    const pending = this.creating.get(sessionId);
    if (pending !== undefined) return pending;
    const create = (async () => {
      const events = await readSessionEvents(this.persistence(), sessionId);
      const exchanges = extractExchanges(events ?? []);
      const context = compressExchanges(exchanges);
      const sessionTitle = extractSessionTitle(events ?? []);
      const web = await this.api.createSession();
      /** @type {QuickAskThread} */
      const thread = {
        chatSessionId: web.id,
        parentMessageId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        contextSent: context,
        sessionTitle,
        exchanges: [],
      };
      // Seed the thread with the primer when there IS context. A session with
      // no readable log (blank session, missing persistence) starts bare; the
      // panel still works, it just has no background.
      let parentId = null;
      if (context !== '') {
        parentId = await this.sendAndSettle(web.id, null, contextPrimer(context), false);
      }
      thread.parentMessageId = parentId;
      // Tag the conversation BEFORE it can ever meet a sync pass. The web
      // product refuses to rename an empty conversation, so the rename rides
      // the primer's completion; a bare thread (no context) is renamed after
      // its first panel answer settles instead (`stream` does that).
      try {
        await this.api.renameSession(web.id, quickAskTitle(sessionTitle));
        thread.titled = true;
      } catch (error) {
        // Not fatal: the ledger row still excludes this thread from import, and
        // a later settled exchange retries the rename below.
        this.warn(`deepseek-web: could not tag the quick-ask conversation: ${String(error)}`);
      }
      this.store.state.quickAsk[sessionId] = thread;
      await this.store.flush();
      return thread;
    })();
    this.creating.set(sessionId, create);
    try {
      return await create;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  /**
   * Drop the current thread and seed a fresh one with the LATEST context.
   *
   * The old web conversation is not deleted (the web product owns it now); the
   * panel simply never references it again.
   *
   * @param {string} sessionId
   * @returns {Promise<QuickAskThread>}
   */
  async refreshThread(sessionId) {
    delete this.store.state.quickAsk[sessionId];
    await this.store.flush();
    return this.ensureThread(sessionId);
  }

  /**
   * Upload one panel attachment to the web product.
   *
   * The panel's files never touch the DSH attachment store: they go straight
   * from the browser to `upload_file` and are referenced by id on the next
   * completion, exactly like the conversation surface does. The model type
   * follows the media type (`vision` for images, `file` for documents).
   *
   * @param {{ bytes: Uint8Array, fileName: string, mediaType?: string, signal?: AbortSignal }} request
   * @returns {Promise<string>} the web file id for `ref_file_ids`.
   */
  async uploadFile(request) {
    if (!this.api.ready) {
      throw new Error('未配置 user token，请先在设置页保存');
    }
    const fileName = typeof request.fileName === 'string' && request.fileName.trim() !== ''
      ? request.fileName.trim().replace(/[\\/]/gu, '_')
      : '';
    const mediaType = typeof request.mediaType === 'string' && request.mediaType !== ''
      ? request.mediaType
      : mediaTypeForName(fileName);
    const named = /\.[A-Za-z0-9]{1,8}$/u.test(fileName)
      ? fileName
      : `${fileName === '' ? 'file' : fileName}.${mediaType.startsWith('image/') ? (mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)) : 'bin'}`;
    return this.api.uploadFile({
      bytes: request.bytes,
      mediaType,
      fileName: named,
      modelType: mediaType.startsWith('image/') ? 'vision' : 'file',
      thinking: false,
      signal: request.signal,
    });
  }

  /**
   * Send one prompt and return the settled answer's parent message id.
   *
   * Used only for the context primer during thread creation; panel questions
   * go through {@link stream} so the user sees the reply arrive.
   *
   * @param {string} chatSessionId
   * @param {number | null} parentMessageId
   * @param {string} prompt
   * @param {boolean} thinking
   * @returns {Promise<number | null>}
   */
  async sendAndSettle(chatSessionId, parentMessageId, prompt, thinking) {
    let parentId = parentMessageId;
    for await (const event of this.api.streamCompletion({
      chatSessionId,
      prompt,
      parentMessageId,
      thinking,
    })) {
      if (event.kind === 'message' && typeof event.messageId === 'number') {
        parentId = event.messageId;
      }
      if (event.kind === 'done') break;
    }
    return parentId;
  }

  /**
   * Stream one panel question to the web thread as SSE the panel can render.
   *
   * Events (one JSON object per `data:` line):
   *   `{"kind":"start"}`                      — the turn began
   *   `{"kind":"reasoning","text":"…"}`       — a thinking fragment
   *   `{"kind":"answer","text":"…"}`          — an answer fragment
   *   `{"kind":"done"}`                       — the turn settled
   *   `{"kind":"error","message":"…"}`        — the turn failed
   *
   * The transcript record is appended AFTER the stream settles, so a reload
   * mid-answer never shows a half turn as if it were complete.
   *
   * @param {string} sessionId
   * @param {string} prompt
   * @param {{ thinking?: boolean, search?: boolean, signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<{ kind: string, text?: string, message?: string }>}
   */
  async *stream(sessionId, prompt, options = {}) {
    if (this.streaming.has(sessionId)) {
      yield { kind: 'error', message: '上一条回复还在进行中' };
      return;
    }
    const text = String(prompt ?? '').trim();
    if (text === '') {
      yield { kind: 'error', message: '空消息' };
      return;
    }
    if (!this.api.ready) {
      yield { kind: 'error', message: '未配置 user token，请先在设置页保存' };
      return;
    }
    this.streaming.add(sessionId);
    try {
      const thread = await this.ensureThread(sessionId);
      yield { kind: 'start' };
      // The question's clock starts when the panel asked; the answer's when it
      // settled, so the transcript can print both times.
      const askedAt = Date.now();
      /** Attachment names the panel uploaded for this turn (display only). */
      const files = Array.isArray(options.files)
        ? options.files
          .filter((file) => file !== null && typeof file === 'object' && typeof file.name === 'string' && file.name !== '')
          .map((file) => ({ name: file.name }))
        : [];
      let answer = '';
      let reasoning = '';
      let parentId = thread.parentMessageId;
      try {
        for await (const event of this.api.streamCompletion({
          chatSessionId: thread.chatSessionId,
          prompt: text,
          parentMessageId: thread.parentMessageId,
          thinking: options.thinking === true,
          search: options.search === true,
          refFileIds: Array.isArray(options.refFileIds) ? options.refFileIds.filter((id) => typeof id === 'string' && id !== '') : [],
          signal: options.signal,
        })) {
          if (event.kind === 'message' && typeof event.messageId === 'number') {
            parentId = event.messageId;
            continue;
          }
          if (event.kind === 'fragment' && event.text !== '') {
            if (event.fragmentType === 'THINK') {
              reasoning += event.text;
              yield { kind: 'reasoning', text: event.text };
            } else {
              answer += event.text;
              yield { kind: 'answer', text: event.text };
            }
            continue;
          }
          if (event.kind === 'done') break;
        }
      } catch (error) {
        // A failure after the POST may already have reached the model; keep the
        // parent marker untouched so a retry does not fork the thread, and
        // report the failure to the panel.
        yield { kind: 'error', message: String(error?.message ?? error) };
        return;
      }
      thread.parentMessageId = parentId;
      thread.updatedAt = Date.now();
      thread.exchanges.push({ role: 'user', text: clipStored(text), at: askedAt, ...(files.length > 0 ? { files } : {}) });
      thread.exchanges.push({ role: 'assistant', text: clipStored(answer), at: Date.now() });
      if (thread.exchanges.length > MAX_STORED_EXCHANGES * 2) {
        thread.exchanges.splice(0, thread.exchanges.length - MAX_STORED_EXCHANGES * 2);
      }
      // A bare thread could not be renamed at creation (the web product
      // refuses an empty conversation); the first settled exchange is the
      // first moment the tag can land. Retried until it sticks.
      if (thread.titled !== true) {
        try {
          await this.api.renameSession(thread.chatSessionId, quickAskTitle(thread.sessionTitle));
          thread.titled = true;
        } catch (error) {
          this.warn(`deepseek-web: could not tag the quick-ask conversation: ${String(error)}`);
        }
      }
      await this.store.flush();
      yield { kind: 'done' };
    } finally {
      this.streaming.delete(sessionId);
    }
  }
}
