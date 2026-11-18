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

import { randomUUID } from 'node:crypto';
import { solvePowOffThread } from './pow-async.js';
import { powResponseHeader } from './pow.js';

/** Public web origin. */
export const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
/** Endpoint the PoW challenge is minted for. */
const COMPLETION_PATH = '/api/v0/chat/completion';
/** Endpoint images are uploaded to; the challenge is minted for this path separately. */
const UPLOAD_PATH = '/api/v0/file/upload_file';

/**
 * Browser-shape constants.
 *
 * The web product now exposes a client version and reads two short-lived HIF
 * tokens (`x-hif-leim` / `x-hif-dliq`) on normal API traffic. Sending an old
 * version string, no User-Agent, or a non-UUID device id is a strong
 * "this is not the browser" signal, so the client keeps these values current.
 * `locale` and `deviceModel` are configurable; the version/bundle/UA constants
 * follow the supported web client.
 */
const CLIENT_VERSION = '2.8.0';
const CLIENT_BUNDLE_ID = 'com.deepseek.chat';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** Small, jittered gap between ordinary API calls. */
const MIN_REQUEST_GAP_MS = 320;
/** HIF tokens are short-lived; never trust one longer than this. */
const HIF_MAX_TTL_MS = 10 * 60_000;
/** If a HIF refresh fails, retry after this long without blocking requests. */
const HIF_RETRY_MS = 60_000;
const HIF_ENDPOINTS = Object.freeze({
  leim: 'https://hif-leim.deepseek.com/query',
  dliq: 'https://hif-dliq.deepseek.com/query',
});

/** Sleep without an unref'd timer (the caller is waiting for it). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Locale text the web client sends (`zh_CN`, not `zh-CN`). */
function clientLocale() {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    return locale.replace('-', '_');
  } catch {
    return 'en_US';
  }
}

/** Normalize a configured locale to the web client's underscore form. */
function normalizeLocale(value) {
  return String(value).trim().replace('-', '_') || 'en_US';
}

/** Seconds east of UTC; the browser's `getTimezoneOffset` is the inverse. */
function timezoneOffsetSeconds() {
  try {
    return -new Date().getTimezoneOffset() * 60;
  } catch {
    return 0;
  }
}

/**
 * Request deadlines.
 *
 * Without them a stalled connection holds its caller forever — and since sync
 * passes are serialized, one hung list request disables synchronization until the
 * process restarts. The completion stream gets a longer budget because the server
 * itself caps a single generation near 60 s, and an idle gap that long means the
 * stream is abandoned.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
/**
 * Image parse wait: how often `fetch_files` is polled and for how long. The
 * server parses asynchronously; small images settle in about a second, large
 * screenshots take longer, and a completion referencing a still-parsing id is
 * refused outright.
 */
const FILE_PARSE_POLL_MS = 1_200;
const FILE_PARSE_TIMEOUT_MS = 60_000;

/** Emit a diagnostic once per process for a condition that repeats every call. */
const emitted = new Set();
function warnOnce(message) {
  if (emitted.has(message)) return;
  emitted.add(message);
  try {
    console.warn(message);
  } catch {
    /* a missing console must not break the request */
  }
}

/**
 * Record that an error definitely happened before the prompt was sent.
 *
 * Applies to any thrown value, not just `DeepSeekWebError`: a plain TypeError from
 * malformed challenge data also proves nothing reached the model.
 *
 * @param {unknown} error
 */
function markUnsubmitted(error) {
  setSubmitted(error, false);
}

/**
 * Record that an error's request state cannot be determined.
 *
 * A socket that dies mid-request looks identical whether the server saw the
 * request or not, so a retry risks a duplicate answer. Leaving the marker unset
 * makes the adapter treat it as "do not retry".
 *
 * @param {unknown} error
 */
function markSubmittedUnknown(error) {
  setSubmitted(error, undefined);
}

/** @param {unknown} error @param {boolean | undefined} value */
function setSubmitted(error, value) {
  if (error === null || typeof error !== 'object') return;
  try {
    error.submitted = value;
  } catch {
    // A frozen error keeps its own (unset) state, which already means "unknown".
  }
}

/**
 * Combine a caller signal with a deadline.
 *
 * A caller may pass nothing, a signal, or an already-deadline-bound signal; the
 * result always aborts when either the caller asks or the budget expires.
 *
 * @param {AbortSignal | undefined} signal
 * @param {number} ms
 * @returns {AbortSignal | undefined}
 */
function withDeadline(signal, ms) {
  let timeout;
  try {
    timeout = AbortSignal.timeout(ms);
  } catch {
    return signal;
  }
  if (signal === undefined || signal === null) return timeout;
  try {
    return AbortSignal.any([signal, timeout]);
  } catch {
    // Older runtime without AbortSignal.any: the deadline alone still prevents
    // an unbounded hang, which is the failure this guard exists for.
    return timeout;
  }
}

/** Fragment types that carry model output. */
const FRAGMENT_THINK = 'THINK';
const FRAGMENT_RESPONSE = 'RESPONSE';

/** Raised for an HTTP/business failure so callers can distinguish auth, quota, PoW. */
export class DeepSeekWebError extends Error {
  /**
   * @param {string} message - human-readable failure.
   * @param {string} code - stable machine code.
   * @param {{ status?: number, bizCode?: number, cause?: unknown, submitted?: boolean }} [meta]
   */
  constructor(message, code, meta = {}) {
    super(message, meta.cause === undefined ? undefined : { cause: meta.cause });
    this.name = 'DeepSeekWebError';
    this.code = code;
    this.status = meta.status;
    this.bizCode = meta.bizCode;
    /**
     * Whether the completion request had been sent when this failed.
     *
     * Failures before the POST (no challenge, unsolved PoW, connection refused)
     * can be retried safely: the model never saw anything. Failures after it may
     * still produce a reply server-side, so a retry risks two answers to the same
     * message. The adapter uses this to decide whether to release its dedup memo.
     *
     * @type {boolean | undefined}
     */
    this.submitted = meta.submitted;
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
    this.deviceId = options.deviceId ?? randomUUID();
    this.deviceModel = typeof options.deviceModel === 'string' ? options.deviceModel : '';
    this.locale = typeof options.locale === 'string' && options.locale !== ''
      ? normalizeLocale(options.locale)
      : clientLocale();
    this.userAgent = typeof options.userAgent === 'string' && options.userAgent !== '' ? options.userAgent : BROWSER_UA;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // HIF is a browser-compatibility signal. Tests and callers that inject a
    // transport opt out unless they explicitly ask for it.
    this.hifEnabled = options.hif === true || (options.hif !== false && options.fetchImpl === undefined);
    /** @type {{ leim: string, dliq: string, leimAt: number, dliqAt: number, leimRetryAt: number, dliqRetryAt: number, pending: Promise<void> | null }} */
    this.hif = { leim: '', dliq: '', leimAt: 0, dliqAt: 0, leimRetryAt: 0, dliqRetryAt: 0, pending: null };
    this.requestGapMs = Number.isFinite(options.requestGapMs) ? Math.max(0, Number(options.requestGapMs)) : MIN_REQUEST_GAP_MS;
    this.nextRequestAt = 0;
    this.rateLimitSeconds = 0;
    /** When a healthy `chat/status` response asked to be polled again. */
    this.statusPollAfter = 0;
    /** Set after a 401/403 so the settings page can say "expired", not "configured". */
    this.authRejected = false;
  }

  /** @param {{ token?: string, deviceId?: string, deviceModel?: string, locale?: string, baseUrl?: string }} next */
  configure(next) {
    if (next.token !== undefined) {
      this.token = next.token.trim();
      this.authRejected = false;
    }
    if (next.deviceId !== undefined) this.deviceId = next.deviceId;
    if (next.deviceModel !== undefined) this.deviceModel = next.deviceModel;
    if (next.locale !== undefined) this.locale = next.locale;
    if (next.baseUrl !== undefined) this.baseUrl = normalizeBaseUrl(next.baseUrl);
  }

  /** Whether a token is present; callers use this to degrade instead of throwing. */
  get ready() {
    return this.token.length > 0;
  }

  /** Browser-like headers shared by API and HIF calls (no auth). */
  browserHeaders() {
    return {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      'Accept-Language': `${this.locale.replace('_', '-')},${this.locale.startsWith('zh') ? 'zh;q=0.9,en;q=0.8' : 'en;q=0.9,zh;q=0.8'}`,
      'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'x-client-bundle-id': CLIENT_BUNDLE_ID,
      'x-client-platform': 'web',
      'x-client-version': CLIENT_VERSION,
      'x-client-locale': this.locale,
      'x-client-timezone-offset': String(timezoneOffsetSeconds()),
      'x-device-id': this.deviceId,
      'x-device-model': this.deviceModel,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
    };
  }

  /** Headers common to every authenticated call. */
  headers(extra = {}) {
    return {
      ...this.browserHeaders(),
      Authorization: `Bearer ${this.token}`,
      ...(this.hif.leim !== '' ? { 'x-hif-leim': this.hif.leim } : {}),
      ...(this.hif.dliq !== '' ? { 'x-hif-dliq': this.hif.dliq } : {}),
      ...extra,
    };
  }

  /**
   * Refresh the short-lived HIF tokens if they are due.
   *
   * The query endpoints are unauthenticated and return a token plus an
   * `x-hif-ttl` header. They are risk-control signals, not user data; failure is
   * non-fatal and must never block a request. One endpoint being unreachable
   * keeps the other token; the DNS for `hif-dliq` is intermittent on some
   * networks, so both are attempted independently.
   */
  async ensureHif() {
    if (!this.hifEnabled) return;
    const now = Date.now();
    const due = Object.keys(HIF_ENDPOINTS).filter((key) => (
      this.hif[`${key}At`] <= now && this.hif[`${key}RetryAt`] <= now
    ));
    if (due.length === 0) return;
    if (this.hif.pending !== null) return this.hif.pending;
    const refresh = (async () => {
      const results = await Promise.allSettled(due.map(async (key) => {
        const response = await this.fetchImpl(HIF_ENDPOINTS[key], {
          headers: this.browserHeaders(),
          signal: withDeadline(undefined, 8_000),
        });
        if (!response.ok) throw new Error(`${key} HIF answered HTTP ${response.status}`);
        const json = await response.json();
        const value = json?.data?.biz_data?.value;
        if (typeof value !== 'string' || value === '') throw new Error(`${key} HIF returned no value`);
        const ttlSeconds = Number(response.headers?.get?.('x-hif-ttl') ?? 0);
        const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : HIF_MAX_TTL_MS;
        return { key, value, ttl: Math.min(ttl, HIF_MAX_TTL_MS) };
      }));
      let refreshed = false;
      results.forEach((result, index) => {
        const key = due[index];
        if (result.status === 'fulfilled') {
          refreshed = true;
          this.hif[key] = result.value.value;
          this.hif[`${key}At`] = Date.now() + result.value.ttl;
          this.hif[`${key}RetryAt`] = 0;
        } else {
          this.hif[`${key}RetryAt`] = Date.now() + HIF_RETRY_MS;
        }
      });
      if (!refreshed) warnOnce('deepseek-web: HIF risk-control tokens are unavailable; continuing without them');
    })().catch(() => {
      for (const key of due) this.hif[`${key}RetryAt`] = Date.now() + HIF_RETRY_MS;
    }).finally(() => {
      this.hif.pending = null;
    });
    this.hif.pending = refresh;
    return refresh;
  }

  /**
   * Respect server pacing hints and keep a small gap between ordinary calls.
   *
   * A burst of list/history requests from one process is a machine signature.
   * `x-fetch-after-sec` / `retry-after` are honored; a large wait becomes a
   * typed RATE_LIMITED error instead of an unbounded silent wait.
   */
  async reserveRequest() {
    const now = Date.now();
    if (this.rateLimitSeconds > 0 && this.nextRequestAt > now && this.rateLimitSeconds > 10) {
      throw new DeepSeekWebError(
        `deepseek-web: the web product asked for a ${this.rateLimitSeconds}s pause; try again later`,
        'RATE_LIMITED',
        { status: 429, submitted: false },
      );
    }
    if (this.nextRequestAt <= now) this.rateLimitSeconds = 0;
    const start = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = start + this.requestGapMs + Math.floor(Math.random() * 80);
    if (start > now) await sleep(start - now);
  }

  /** Read pacing headers from one response. */
  noteRateHeaders(response, path = '') {
    const raw = response.headers?.get?.('x-fetch-after-sec') || response.headers?.get?.('retry-after');
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const hard = response.status === 429 || response.status === 503;
    if (path === '/api/v0/chat/status' && !hard) {
      // On a healthy status response this is "poll again in N seconds", not a
      // global rate limit. Honoring 120s here would block the next sync.
      this.statusPollAfter = Date.now() + seconds * 1000;
      return;
    }
    this.rateLimitSeconds = hard ? seconds : Math.min(seconds, 5);
    this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.rateLimitSeconds * 1000);
  }

  /** Turn a WAF/captcha/challenge response into a typed, actionable failure. */
  challengeFailure(response) {
    const waf = response.headers?.get?.('x-amzn-waf-action');
    const mitigated = response.headers?.get?.('cf-mitigated');
    if (waf !== 'captcha' && waf !== 'challenge' && mitigated !== 'challenge') return null;
    return new DeepSeekWebError(
      'deepseek-web: 网页端要求人机验证（captcha/challenge）。请用浏览器打开 chat.deepseek.com 完成验证后重试；插件不会自动绕过验证',
      'CHALLENGE_REQUIRED',
      { status: response.status, submitted: false },
    );
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
    await this.ensureHif();
    await this.reserveRequest();
    const url = new URL(path, this.baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    /** @type {RequestInit} */
    const init = {
      method,
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      signal: withDeadline(signal, REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(url.toString(), init);
    this.noteRateHeaders(response, path);
    const challenge = this.challengeFailure(response);
    if (challenge !== null) throw challenge;
    // Status comes before body parsing: a WAF/nginx 429 or 403 page is often
    // HTML, and parsing it as JSON would misclassify it as a retryable
    // TRANSPORT failure.
    if (response.status === 401 || response.status === 403) {
      this.authRejected = true;
      throw new DeepSeekWebError(`deepseek-web: ${path} rejected the token (HTTP ${response.status})`, 'UNAUTHORIZED', {
        status: response.status,
      });
    }
    if (response.status === 429) {
      throw new DeepSeekWebError(
        `deepseek-web: ${path} was rate limited (HTTP 429); wait before retrying`,
        'RATE_LIMITED',
        { status: 429, submitted: false },
      );
    }
    const replyType = String(response.headers?.get?.('content-type') ?? '');
    if (replyType.toLowerCase().includes('text/html')) {
      throw new DeepSeekWebError(
        `deepseek-web: ${path} returned an HTML page instead of JSON, likely a risk-control/challenge page`,
        'CHALLENGE_REQUIRED',
        { status: response.status, submitted: false },
      );
    }
    const text = await response.text();
    let json;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch (error) {
      throw new DeepSeekWebError(
        `deepseek-web: ${path} returned non-JSON (HTTP ${response.status})`,
        'TRANSPORT',
        { status: response.status, cause: error },
      );
    }
    if (!response.ok) {
      throw new DeepSeekWebError(`deepseek-web: ${path} failed (HTTP ${response.status})`, 'TRANSPORT', {
        status: response.status,
      });
    }
    const data = unwrap(json, path);
    this.authRejected = false;
    return data;
  }

  /** The signed-in account. Confirms the token before anything else is attempted. */
  currentUser() {
    return this.request('/api/v0/users/current');
  }

  /**
   * Read-only account/chat status: mute state and the server's pacing hint.
   *
   * Used by the manual credential check, so the settings page can distinguish
   * "token invalid" from "account muted / temporarily restricted".
   *
   * @returns {Promise<{ isMuted: boolean, muteUntil: string | null, message: string | null }>}
   */
  async chatStatus() {
    const data = await this.request('/api/v0/chat/status');
    return {
      isMuted: Number(data?.is_muted) > 0,
      muteUntil: typeof data?.mute_until === 'string' ? data.mute_until : null,
      message: typeof data?.msg === 'string' ? data.msg : null,
    };
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
   * Parse status of one uploaded file, by id.
   *
   * An upload lands as `PENDING` and settles server-side (`SUCCESS` or a parse
   * failure) without further client work; the completion call only accepts ids
   * whose parse has finished.
   *
   * @param {string} fileId
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ id: string, status: string, auditResult: string, tokenUsage: number | null }>}
   */
  async fetchFileStatus(fileId, options = {}) {
    const data = await this.request('/api/v0/file/fetch_files', {
      query: { file_ids: fileId },
      signal: options.signal,
    });
    const file = Array.isArray(data?.files) ? data.files.find((row) => String(row.id) === fileId) : undefined;
    if (file === undefined) {
      throw new DeepSeekWebError(`deepseek-web: file ${fileId} is no longer visible`, 'MALFORMED');
    }
    return {
      id: String(file.id),
      status: String(file.status ?? ''),
      auditResult: String(file.audit_result ?? ''),
      tokenUsage: Number(file.token_usage) || null,
    };
  }

  /**
   * Upload one file — image or document — and wait for its parse to settle.
   *
   * The browser client uploads through `POST /api/v0/file/upload_file` with a
   * multipart form whose only field is `file`. Three custom headers ride along:
   * the PoW proof solved for THIS endpoint (`target_path` differs from the
   * completion one, so the completion header cannot be reused), the model kind
   * the file is destined for (`vision` for images, `file` for documents), and
   * the byte size. The reply's `data.biz_data.id` is the value `ref_file_ids`
   * takes on the next completion call.
   *
   * The upload lands as `PENDING` and the server parses it asynchronously; a
   * completion referencing a still-parsing id is refused with HTTP 422. This
   * call therefore polls `fetch_files` until the status leaves `PENDING` —
   * `SUCCESS` returns the id, anything else is an error.
   *
   * A settled `FAILED` parse is retried once with a fresh upload: the parse
   * runs on an asynchronous server-side queue, and a one-off failure there is
   * not a statement about the file. Every failure here happens before the
   * completion POST, so callers may treat it as "nothing was submitted".
   *
   * @param {{
   *   bytes: Uint8Array,
   *   mediaType: string,
   *   fileName: string,
   *   modelType?: 'vision' | 'file',
   *   thinking?: boolean,
   *   signal?: AbortSignal,
   * }} request
   * @returns {Promise<string>} the uploaded file's id.
   */
  async uploadFile(request) {
    try {
      return await this.uploadOnce(request);
    } catch (error) {
      if (error?.code !== 'PARSE_FAILED') throw error;
      try {
        return await this.uploadOnce(request);
      } catch (second) {
        const cause = second instanceof Error ? second : new Error(String(second));
        const detail = `${request.fileName ?? 'file'}, ${request.mediaType ?? 'unknown type'}, ${request.bytes?.byteLength ?? 0} bytes`;
        throw new DeepSeekWebError(
          `deepseek-web: file parse failed after a retry (${cause.message}; ${detail})`,
          'PARSE_FAILED',
          { cause, submitted: false },
        );
      }
    }
  }

  /**
   * One upload attempt: PoW, multipart POST, envelope check, parse wait.
   *
   * Kept separate from {@link uploadFile} so the parse-failure retry re-solves
   * the PoW and mints a NEW file id instead of polling the dead one.
   *
   * @param {{
   *   bytes: Uint8Array,
   *   mediaType: string,
   *   fileName: string,
   *   modelType?: 'vision' | 'file',
   *   thinking?: boolean,
   *   signal?: AbortSignal,
   * }} request
   * @returns {Promise<string>}
   */
  async uploadOnce(request) {
    if (!this.ready) {
      throw new DeepSeekWebError('deepseek-web: no token configured', 'MISSING_CREDENTIAL', { submitted: false });
    }
    await this.ensureHif();
    await this.reserveRequest();
    const { bytes, mediaType, fileName, modelType = 'file', thinking = false, signal } = request;

    const powHeader = await this.solveChallenge(UPLOAD_PATH, { signal }).catch((error) => {
      markUnsubmitted(error);
      throw error;
    });

    /** The browser sends exactly these three custom headers alongside the PoW proof. */
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mediaType }), fileName);

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${UPLOAD_PATH}`, {
        method: 'POST',
        headers: this.headers({
          'X-DS-PoW-Response': powHeader,
          'x-thinking-enabled': thinking ? '1' : '0',
          'x-model-type': modelType,
          'x-file-size': String(bytes.length),
        }),
        body: form,
        signal: withDeadline(signal, REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      markUnsubmitted(error);
      throw error;
    }

    const text = await response.text();
    this.noteRateHeaders(response, UPLOAD_PATH);
    const challenge = this.challengeFailure(response);
    if (challenge !== null) throw challenge;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.authRejected = true;
      if (response.status === 429) {
        throw new DeepSeekWebError('deepseek-web: file upload was rate limited (HTTP 429)', 'RATE_LIMITED', {
          status: 429,
          submitted: false,
        });
      }
      throw new DeepSeekWebError(
        `deepseek-web: file upload failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'TRANSPORT',
        { status: response.status },
      );
    }
    let json;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch (error) {
      throw new DeepSeekWebError('deepseek-web: file upload returned non-JSON', 'MALFORMED', { cause: error });
    }
    this.authRejected = false;
    if (json?.code !== 0 || json?.data?.biz_code !== 0) {
      throw new DeepSeekWebError(
        `deepseek-web: file upload rejected (${json?.data?.biz_msg || json?.msg || 'unknown'})`,
        'BIZ',
      );
    }
    const id = json.data.biz_data?.id;
    if (typeof id !== 'string' || id === '') {
      throw new DeepSeekWebError('deepseek-web: file upload returned no file id', 'MALFORMED');
    }
    await this.waitForFile(id, { signal });
    return id;
  }

  /**
   * Upload one image and wait for its parse to settle.
   *
   * @param {{
   *   bytes: Uint8Array,
   *   mediaType: string,
   *   fileName?: string,
   *   thinking?: boolean,
   *   signal?: AbortSignal,
   * }} request
   * @returns {Promise<string>} the uploaded file's id.
   */
  async uploadImage(request) {
    return this.uploadFile({
      ...request,
      fileName: request.fileName ?? 'image.png',
      modelType: 'vision',
    });
  }

  /**
   * Poll one uploaded file until its parse leaves `PENDING`.
   *
   * `SUCCESS` resolves; any other settled status (`FAILED` and friends) throws
   * a `PARSE_FAILED` error, because a completion referencing it would be
   * refused. The budget is a fixed number of polls with a fixed gap —
   * generous enough for large screenshots, bounded enough that a stuck parse
   * cannot hang a turn for minutes.
   *
   * @param {string} fileId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async waitForFile(fileId, options = {}) {
    const { signal } = options;
    const deadline = Date.now() + FILE_PARSE_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
      if (signal?.aborted === true) {
        throw new DeepSeekWebError('deepseek-web: file parse wait aborted', 'ABORTED', { submitted: false });
      }
      let status;
      try {
        status = await this.fetchFileStatus(fileId, { signal });
      } catch (error) {
        markUnsubmitted(error);
        throw error;
      }
      last = status.status;
      if (status.status === 'SUCCESS') return;
      if (status.status !== 'PENDING' && status.status !== 'PARSING') {
        throw new DeepSeekWebError(
          `deepseek-web: file parse did not succeed (status ${status.status}, audit ${status.auditResult || 'unknown'})`,
          'PARSE_FAILED',
          { submitted: false },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_PARSE_POLL_MS));
    }
    throw new DeepSeekWebError(`deepseek-web: file parse timed out (last status ${last || 'unknown'})`, 'TIMEOUT');
  }

  /**
   * Request and solve the proof-of-work challenge for one target path.
   *
   * The solve runs on a worker thread: it is a ~1 s CPU loop, and blocking the
   * Host's event loop for that long stalls every other session and any sync.
   *
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
    const { answer, offThread } = await solvePowOffThread(challenge, { signal: options.signal });
    if (!offThread) {
      warnOnce('deepseek-web: solving proof-of-work on the main thread (no worker available)');
    }
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
   *   refFileIds?: string[],
   *   signal?: AbortSignal,
   * }} request
   */
  async *streamCompletion(request) {
    if (!this.ready) {
      throw new DeepSeekWebError('deepseek-web: no token configured', 'MISSING_CREDENTIAL', { submitted: false });
    }
    await this.ensureHif();
    const { chatSessionId, prompt, parentMessageId = null, thinking = false, search = false, signal } = request;
    // Everything up to the POST can fail without the model ever seeing the prompt,
    // so those errors are marked `submitted: false` and the adapter may retry.
    // The marker is applied to ANY error, not just `DeepSeekWebError`: a plain
    // TypeError from malformed challenge data also means nothing was sent, and
    // leaving it unmarked made the adapter refuse a perfectly safe retry.
    let powHeader;
    try {
      powHeader = await this.solveChallenge(COMPLETION_PATH, { signal });
    } catch (error) {
      markUnsubmitted(error);
      throw error;
    }

    const body = {
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
      model_type: 'default',
      prompt,
      ref_file_ids: Array.isArray(request.refFileIds) ? request.refFileIds.filter((id) => typeof id === 'string' && id !== '') : [],
      thinking_enabled: thinking,
      search_enabled: search,
      source: 'default',
      action: null,
      preempt: false,
    };

    await this.reserveRequest();

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${COMPLETION_PATH}`, {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-DS-PoW-Response': powHeader,
        }),
        body: JSON.stringify(body),
        // A generation may legitimately run for a minute; the idle guard below is
        // what catches a stream that stops producing without closing.
        signal,
      });
    } catch (error) {
      // A fetch rejection cannot tell "never left this machine" from "the server
      // received it and the response was lost" — the socket closes the same way in
      // both cases. Marking it unsubmitted would let the loop post the same prompt
      // twice, producing two answers to one message, so the outcome is reported as
      // unknown (`submitted` stays unset) and the adapter declines to retry.
      markSubmittedUnknown(error);
      throw error;
    }

    this.noteRateHeaders(response, COMPLETION_PATH);
    const challenge = this.challengeFailure(response);
    if (challenge !== null) throw challenge;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) this.authRejected = true;
      if (response.status === 429) {
        throw new DeepSeekWebError(
          `deepseek-web: completion was rate limited (HTTP 429); wait before retrying`,
          'RATE_LIMITED',
          { status: 429, submitted: false },
        );
      }
      let code = 'TRANSPORT';
      if (text.includes('MISSING_HEADER')) code = 'POW_REQUIRED';
      else if (response.status === 401 || response.status === 403) code = 'UNAUTHORIZED';
      // The server answered, so it may already have started a generation.
      throw new DeepSeekWebError(
        `deepseek-web: completion failed (HTTP ${response.status}) ${text.slice(0, 200)}`,
        code,
        { status: response.status, submitted: true },
      );
    }
    const contentType = String(response.headers?.get?.('content-type') ?? '');
    if (contentType !== '' && !contentType.toLowerCase().includes('text/event-stream')) {
      const text = await response.text().catch(() => '');
      throw new DeepSeekWebError(
        `deepseek-web: completion returned ${contentType}, not an SSE stream${text.includes('<html') ? ' (likely a challenge page)' : ''}`,
        text.includes('<html') || /captcha|challenge|verify/i.test(text) ? 'CHALLENGE_REQUIRED' : 'TRANSPORT',
        { status: response.status, submitted: false },
      );
    }
    if (response.body === null) {
      throw new DeepSeekWebError('deepseek-web: completion returned no body', 'EMPTY_RESPONSE', { submitted: true });
    }
    this.authRejected = false;

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

    for await (const event of readSse(response.body, signal, STREAM_IDLE_TIMEOUT_MS)) {
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
 * Parsed line by line rather than by splitting on `\n\n`, because the spec allows
 * CRLF and a chunk boundary can land anywhere. The earlier split-on-`\n\n` version
 * silently merged two `\r\n\r\n`-separated records into one unparsable blob and
 * emitted `data: null` — losing the whole response while looking like a clean
 * stream.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} [signal]
 * @param {number} [idleMs] - abort when no chunk arrives for this long; 0 disables.
 */
export async function* readSse(body, signal, idleMs = 0) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = 'message';
  /** @type {string[]} */
  let dataLines = [];

  /** Build the event for the block that just ended, if it carried data. */
  const dispatch = () => {
    if (dataLines.length === 0) {
      eventType = 'message';
      return undefined;
    }
    const text = dataLines.join('\n');
    const event = { type: eventType, data: parseJsonOrNull(text) };
    eventType = 'message';
    dataLines = [];
    return event;
  };

  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) return;
      // `reader.read()` blocks until the server sends something. A stream that
      // stops producing without closing would otherwise hang its caller — and a
      // hung stream also holds the serialized sync pass forever.
      const { value, done } = await readWithIdle(reader, idleMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const lf = buffer.indexOf('\n');
        if (lf < 0) break;
        let line = buffer.slice(0, lf);
        buffer = buffer.slice(lf + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          const event = dispatch();
          if (event !== undefined) yield event;
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
        // Other SSE fields (id:, retry:, comments) carry nothing we consume.
      }
    }
    // A trailing block without its blank line still counts.
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer !== '') {
      if (buffer.startsWith('event:')) eventType = buffer.slice(6).trim();
      else if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
    }
    const last = dispatch();
    if (last !== undefined) yield last;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* an already-closed stream is not an error */
    }
  }
}

/**
 * `reader.read()` bounded by an idle deadline.
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} idleMs - 0 disables the guard.
 */
async function readWithIdle(reader, idleMs) {
  if (!(idleMs > 0)) return reader.read();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => {
        // Deliberately NOT unref'd: this timer is the only thing that can settle
        // the race when the server goes silent, and an unref'd timer lets the
        // process exit before it fires.
        timer = setTimeout(() => {
          reject(new DeepSeekWebError(
            `deepseek-web: the response stream went idle for ${idleMs} ms`,
            'TIMEOUT',
          ));
        }, idleMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** @param {string} text */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
