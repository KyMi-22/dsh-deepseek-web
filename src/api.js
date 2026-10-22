/**
 * DeepSeek web (chat.deepseek.com) API client.
 *
 * Everything here was verified against the live service. The endpoint family is
 * `/api/v0/...` and authentication is a single `Authorization: Bearer <token>`
 * header: the extra `x-client-*` / `x-device-id` headers the web app sends are
 * not required, though a stable device id is kept so the server sees one client.
 *
 * Two facts shape this module:
 *
 *  - `POST /api/v0/chat/completion` is refused with `40300 MISSING_HEADER`
 *    unless it carries `X-DS-PoW-Response`, a proof-of-work header solved for
 *    the exact challenge the server hands out per request.
 *  - the reply is an SSE stream of JSON-patch fragments, not a plain token
 *    stream, so `streamCompletion` interprets the patch language rather than
 *    assuming `data: <text>`.
 *
 * @module src/api
 */
'use strict';

import { powResponseHeader, solvePow } from './pow.js';

/** Public web origin. */
export const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
/** Endpoint the PoW challenge is minted for. */
const COMPLETION_PATH = '/api/v0/chat/completion';

/** Fragment types that carry model output. */
const FRAGMENT_THINK = 'THINK';
const FRAGMENT_RESPONSE = 'RESPONSE';

/** Raised for an HTTP/business failure so callers can distinguish auth, quota, PoW. */
export class DeepSeekWebError extends Error {
  /**
   * @param {string} message - human-readable failure.
   * @param {string} code - stable machine code.
   * @param {{ status?: number, bizCode?: number, cause?: unknown }} [meta]
   */
  constructor(message, code, meta = {}) {
    super(message, meta.cause === undefined ? undefined : { cause: meta.cause });
    this.name = 'DeepSeekWebError';
    this.code = code;
    this.status = meta.status;
    this.bizCode = meta.bizCode;
  }
}

/** Unwrap the service's `{ code, msg, data: { biz_code, biz_msg, biz_data } }` envelope. */
function unwrap(json, context) {
  if (json === null || typeof json !== 'object') {
    throw new DeepSeekWebError(`${context}: response was not a JSON object`, 'MALFORMED');
  }
  const outer = /** @type {any} */ (json);
  if (outer.code !== undefined && outer.code !== 0) {
    throw new DeepSeekWebError(`${context}: ${outer.msg ?? 'request failed'}`, 'API', { bizCode: outer.code });
  }
  const data = outer.data;
  if (data === null || typeof data !== 'object') return undefined;
  if (data.biz_code !== undefined && data.biz_code !== 0) {
    const code = data.biz_code === 40300 ? 'POW_REQUIRED' : 'BIZ';
    throw new DeepSeekWebError(`${context}: ${data.biz_msg ?? 'request failed'}`, code, { bizCode: data.biz_code });
  }
  return data.biz_data;
}

/**
 * Trailing-slash-free base URL.
 * @param {string | undefined} value
 */
function normalizeBaseUrl(value) {
  const url = (value ?? DEFAULT_BASE_URL).trim();
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** One client bound to one credential. */
export class DeepSeekWebApi {
  /**
   * @param {{ token?: string, baseUrl?: string, deviceId?: string, fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.token = (options.token ?? '').trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.deviceId = options.deviceId ?? 'dsh-deepseek-web';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** @param {{ token?: string, deviceId?: string, baseUrl?: string }} next */
  configure(next) {
    if (next.token !== undefined) this.token = next.token.trim();
    if (next.deviceId !== undefined) this.deviceId = next.deviceId;
    if (next.baseUrl !== undefined) this.baseUrl = normalizeBaseUrl(next.baseUrl);
  }

  /** Whether a token is present; callers use this to degrade instead of throwing. */
  get ready() {
    return this.token.length > 0;
  }

  /** Headers common to every call. */
  headers(extra = {}) {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
      'x-client-bundle-id': 'com.deepseek.chat-web-prod',
      'x-client-platform': 'web',
      'x-client-version': '20241120',
      'x-client-locale': 'en_US',
      'x-client-timezone-offset': '0',
      'x-device-id': this.deviceId,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      ...extra,
    };
  }

  /**
   * One JSON request.
   * @param {string} path
   * @param {{ method?: string, query?: Record<string, string | number | null>, body?: unknown, signal?: AbortSignal }} [options]
   */
  async request(path, options = {}) {
    if (!this.ready) {
      throw new DeepSeekWebError('deepseek-web: no token configured', 'MISSING_CREDENTIAL');
    }
    const { method = 'GET', query, body, signal } = options;
    const url = new URL(path, this.baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    /** @type {RequestInit} */
    const init = { method, headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }), signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(url.toString(), init);
    const text = await response.text();
    let json;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch (error) {
      throw new DeepSeekWebError(
        `deepseek-web: ${path} returned non-JSON (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'TRANSPORT',
        { status: response.status, cause: error },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new DeepSeekWebError(`deepseek-web: ${path} rejected the token (HTTP ${response.status})`, 'UNAUTHORIZED', {
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new DeepSeekWebError(`deepseek-web: ${path} failed (HTTP ${response.status})`, 'TRANSPORT', {
        status: response.status,
      });
    }
    return unwrap(json, path);
  }

  /** The signed-in account. Confirms the token before anything else is attempted. */
  currentUser() {
    return this.request('/api/v0/users/current');
  }

  /**
   * Every conversation on the account, newest first.
   *
   * The service pages this endpoint: one page is at most `count` rows and the
   * cursor is `(pinned, updated_at)` of the last row received, so the whole
   * account is walked by following that cursor until `has_more` is false.
   *
   * @param {{ pageSize?: number, maxPages?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Array<{ id: string, title: string, updatedAt: number, pinned: boolean, modelType: string }>>}
   */
  async listSessions(options = {}) {
    const { pageSize = 100, maxPages = 100, signal } = options;
    /** @type {Array<{ id: string, title: string, updatedAt: number, pinned: boolean, modelType: string }>} */
    const all = [];
    let cursorPinned = null;
    let cursorUpdatedAt = null;
    for (let page = 0; page < maxPages; page++) {
      /** @type {Record<string, string | number | null>} */
      const query = { count: pageSize };
      if (cursorPinned !== null) {
        query['lte_cursor.pinned'] = String(cursorPinned);
        query['lte_cursor.updated_at'] = cursorUpdatedAt;
      }
      const data = await this.request('/api/v0/chat_session/fetch_page', { query, signal });
      const rows = Array.isArray(data?.chat_sessions) ? data.chat_sessions : [];
      for (const row of rows) {
        all.push({
          id: String(row.id),
          title: typeof row.title === 'string' && row.title !== '' ? row.title : '（无标题对话）',
          updatedAt: Number(row.updated_at) || 0,
          pinned: row.pinned === true,
          modelType: String(row.model_type ?? 'default'),
        });
      }
      if (data?.has_more !== true || rows.length === 0) break;
      const last = rows[rows.length - 1];
      cursorPinned = last.pinned === true;
      cursorUpdatedAt = Number(last.updated_at) || 0;
    }
    return all;
  }

  /**
   * The full message history of one conversation.
   * @param {string} chatSessionId
   * @returns {Promise<{ session: object, messages: Array<object> } | null>} null when the session no longer exists.
   */
  async getHistory(chatSessionId) {
    let data;
    try {
      data = await this.request('/api/v0/chat/history_messages', {
        query: { chat_session_id: chatSessionId, cache_version: null, cache_reset_at: null },
      });
    } catch (error) {
      if (error instanceof DeepSeekWebError && error.code === 'BIZ') return null;
      throw error;
    }
    if (!data || typeof data !== 'object') return null;
    return { session: data.chat_session ?? {}, messages: Array.isArray(data.chat_messages) ? data.chat_messages : [] };
  }

  /** Mint a new, empty conversation. */
  async createSession() {
    const data = await this.request('/api/v0/chat_session/create', { method: 'POST', body: {} });
    const session = data?.chat_session;
    if (!session?.id) throw new DeepSeekWebError('deepseek-web: create session returned no id', 'MALFORMED');
    return { id: String(session.id), title: session.title ?? null, updatedAt: Number(session.updated_at) || 0 };
  }

  /** Rename a conversation. */
  async renameSession(chatSessionId, title) {
    await this.request('/api/v0/chat_session/update_title', {
      method: 'POST',
      body: { chat_session_id: chatSessionId, title },
    });
  }

  /**
   * Request and solve the proof-of-work challenge for one target path.
   * @param {string} [targetPath]
   * @param {{ signal?: AbortSignal }} [options]
   */
  async solveChallenge(targetPath = COMPLETION_PATH, options = {}) {
    const data = await this.request('/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      body: { target_path: targetPath },
      signal: options.signal,
    });
    const challenge = data?.challenge;
    if (!challenge) throw new DeepSeekWebError('deepseek-web: challenge response carried no challenge', 'MALFORMED');
    const answer = solvePow(challenge, { signal: options.signal });
    if (answer === undefined) {
      throw new DeepSeekWebError('deepseek-web: proof-of-work was not solved within the budget', 'POW_UNSOLVED');
    }
    return powResponseHeader(challenge, answer);
  }

  /**
   * Send one prompt into an existing conversation and stream the parsed reply.
   *
   * Yields events in conversation order:
   *   `{ kind: 'fragment', fragmentType: 'THINK' | 'RESPONSE', text }`
   *   `{ kind: 'message', messageId, parentId }`
   *   `{ kind: 'status', status }`
   *   `{ kind: 'tokens', total }`
   *   `{ kind: 'done' }`
   *
   * @param {{
   *   chatSessionId: string,
   *   prompt: string,
   *   parentMessageId?: number | null,
   *   thinking?: boolean,
   *   search?: boolean,
   *   signal?: AbortSignal,
   * }} request
   */
  async *streamCompletion(request) {
    if (!this.ready) {
      throw new DeepSeekWebError('deepseek-web: no token configured', 'MISSING_CREDENTIAL');
    }
    const { chatSessionId, prompt, parentMessageId = null, thinking = false, search = false, signal } = request;
    const powHeader = await this.solveChallenge(COMPLETION_PATH, { signal });

    const body = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: 'default',
      prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: search,
      source: 'default',
      action: null,
      preempt: false,
    };

    const response = await this.fetchImpl(`${this.baseUrl}${COMPLETION_PATH}`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-DS-PoW-Response': powHeader,
      }),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let code = 'TRANSPORT';
      if (text.includes('MISSING_HEADER')) code = 'POW_REQUIRED';
      else if (response.status === 401 || response.status === 403) code = 'UNAUTHORIZED';
      throw new DeepSeekWebError(
        `deepseek-web: completion failed (HTTP ${response.status}) ${text.slice(0, 200)}`,
        code,
        { status: response.status },
      );
    }
    if (response.body === null) throw new DeepSeekWebError('deepseek-web: completion returned no body', 'EMPTY_RESPONSE');

    let currentPath = '';
    /**
     * The fragment type the next content append belongs to, or `null` for a
     * fragment whose text is not model output.
     *
     * A searching reply carries `TOOL_SEARCH` / `TOOL_OPEN` fragments whose
     * content is harness bookkeeping ("Found 16 web pages", a page snippet).
     * Those must not be rendered as the answer, so they are tracked as a null
     * type and their appends are dropped.
     */
    let currentFragmentType = FRAGMENT_RESPONSE;

    for await (const event of readSse(response.body, signal)) {
      if (event.type === 'update_session') continue;
      if (event.type === 'ready') continue;
      const payload = event.data;
      if (payload === null || typeof payload !== 'object') continue;

      // A whole response object arrives first: seed the fragment type from it.
      if (payload.v && typeof payload.v === 'object' && payload.v.response) {
        const responseBody = payload.v.response;
        if (typeof responseBody.message_id === 'number') {
          yield { kind: 'message', messageId: responseBody.message_id, parentId: responseBody.parent_id ?? null };
        }
        const fragments = Array.isArray(responseBody.fragments) ? responseBody.fragments : [];
        for (const fragment of fragments) {
          currentFragmentType = fragmentTypeOf(fragment.type);
          if (currentFragmentType === null) continue;
          if (typeof fragment.content === 'string' && fragment.content !== '') {
            yield { kind: 'fragment', fragmentType: currentFragmentType, text: fragment.content };
          }
        }
        continue;
      }

      // A new fragment is appended: it switches the active type.
      if (payload.o === 'APPEND' && payload.p === 'response/fragments' && Array.isArray(payload.v)) {
        for (const fragment of payload.v) {
          currentFragmentType = fragmentTypeOf(fragment.type);
          if (currentFragmentType === null) continue;
          if (typeof fragment.content === 'string' && fragment.content !== '') {
            yield { kind: 'fragment', fragmentType: currentFragmentType, text: fragment.content };
          }
        }
        continue;
      }

      // A path switch; the only path that carries model text is fragment content.
      if (typeof payload.p === 'string') {
        if (payload.p.startsWith('response/fragments') && payload.p.endsWith('/content')) {
          currentPath = payload.p;
        } else {
          currentPath = payload.p;
        }
        if (payload.p === 'response/status' && typeof payload.v === 'string') {
          yield { kind: 'status', status: payload.v };
          continue;
        }
        if (payload.p === 'response' && payload.o === 'BATCH' && Array.isArray(payload.v)) {
          // A searching reply wraps the fragment append inside this batch:
          //   {"p":"response","o":"BATCH","v":[
          //      {"p":"fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"…"}]}]}
          // A plain reply appends at the top level instead, so both shapes are
          // handled here.
          for (const patch of payload.v) {
            if (patch === null || typeof patch !== 'object') continue;
            if (patch.p === 'accumulated_token_usage' && typeof patch.v === 'number') {
              yield { kind: 'tokens', total: patch.v };
              continue;
            }
            if (patch.p === 'fragments' && patch.o === 'APPEND' && Array.isArray(patch.v)) {
              for (const fragment of patch.v) {
                currentFragmentType = fragmentTypeOf(fragment.type);
                if (currentFragmentType === null) continue;
                if (typeof fragment.content === 'string' && fragment.content !== '') {
                  yield { kind: 'fragment', fragmentType: currentFragmentType, text: fragment.content };
                }
              }
            }
          }
          continue;
        }
        // Fall through: an APPEND carrying the first text of this path.
        if (payload.o === 'APPEND' && typeof payload.v === 'string') {
          if (currentPath.startsWith('response/fragments') && currentFragmentType !== null) {
            yield { kind: 'fragment', fragmentType: currentFragmentType, text: payload.v };
          }
          continue;
        }
        continue;
      }

      // A bare `{"v": "..."}` continues the current path.
      if (typeof payload.v === 'string' && currentPath.startsWith('response/fragments')) {
        if (currentFragmentType !== null) {
          yield { kind: 'fragment', fragmentType: currentFragmentType, text: payload.v };
        }
        continue;
      }
    }
    yield { kind: 'done' };
  }
}

/**
 * Map a web fragment type onto the two that carry model output.
 *
 * @param {unknown} type
 * @returns {'THINK' | 'RESPONSE' | null}
 */
function fragmentTypeOf(type) {
  if (type === FRAGMENT_THINK) return FRAGMENT_THINK;
  if (type === FRAGMENT_RESPONSE) return FRAGMENT_RESPONSE;
  return null;
}

/**
 * Parse an SSE byte stream into `{ type, data }` events.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} [signal]
 */
export async function* readSse(body, signal) {
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(raw);
        if (event !== undefined) yield event;
      }
    }
    if (buffer.trim() !== '') {
      const event = parseSseBlock(buffer);
      if (event !== undefined) yield event;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* an already-closed stream is not an error */
    }
  }
}

/** @param {string} block */
function parseSseBlock(block) {
  let type = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  const text = dataLines.join('\n');
  try {
    return { type, data: JSON.parse(text) };
  } catch {
    return { type, data: null };
  }
}
