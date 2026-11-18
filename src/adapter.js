/**
 * The `deepseek-web` provider adapter.
 *
 * It satisfies the harness adapter contract structurally: `registerAdapter`
 * exercises the methods instead of testing `instanceof`, so this file never
 * imports a version-pinned base class.
 *
 * ## Why this adapter exists
 *
 * The DeepSeek web product and the metered API are different products. A web
 * session is billed against the site's own free quota, so routing a DSH session
 * through it costs nothing on the API account. This adapter makes the web
 * conversation the model behind a DSH session, which also means the same
 * conversation can be continued from either side.
 *
 * ## Conversation identity
 *
 * One DSH session is pinned to one web conversation. The first turn mints a web
 * conversation and records the mapping; later turns reuse it, so the web side
 * keeps the history and the DSH side keeps its own log. Because the web side
 * already remembers the earlier turns, only the newest user message is sent.
 *
 * ## Tools
 *
 * The web completion endpoint accepts a single `prompt` string and has no
 * function-calling channel, so tools cannot be offered to this model. The
 * adapter therefore declares text-only input and lets the agent loop finish on
 * a plain stop. `ctx.tools.guard` in the plugin entry blocks file-writing tools
 * for these sessions as a second line of defence.
 *
 * @module src/adapter
 */
'use strict';

import { DeepSeekWebError } from './api.js';
import { lastMessageId, planAppend } from './sync.js';

/**
 * How long a recorded parent message stays trusted before it is re-read.
 *
 * The web conversation can move on without this plugin: the user may keep
 * chatting on chat.deepseek.com. Continuing from a stale parent would ask the
 * model to answer a branch that no longer has the latest turns in it, so the
 * parent is refreshed when the last turn was a while ago. Inside a continuous
 * exchange our own replies keep the recorded id fresh and cost no extra request.
 */
const PARENT_STALE_MS = 60_000;

/** Provider route this adapter serves. */
export const PROVIDER = 'deepseek-web';

/** Model ids the picker shows, mapped onto the web request shape. */
export const MODELS = [
  {
    id: 'deepseek-web-chat',
    name: 'DeepSeek 网页版',
    description: '网页版普通对话（chat.deepseek.com），不消耗 API 余额。',
    thinking: false,
    search: false,
  },
  {
    id: 'deepseek-web-reasoner',
    name: 'DeepSeek 网页版 · 深度思考',
    description: '网页版深度思考模式，展示推理过程；同样不消耗 API 余额。',
    thinking: true,
    search: false,
  },
  {
    id: 'deepseek-web-search',
    name: 'DeepSeek 网页版 · 智能搜索',
    description: '开启网页版的联网搜索，回答会联网查证并给出引用来源。',
    thinking: false,
    search: true,
  },
  {
    id: 'deepseek-web-search-think',
    name: 'DeepSeek 网页版 · 搜索 + 深度思考',
    description: '联网搜索与深度思考同时开启，适合需要查证后再推理的问题。',
    thinking: true,
    search: true,
  },
];

/** Resolve one model row from its id. */
function modelRow(model) {
  return MODELS.find((entry) => entry.id === model) ?? MODELS[0];
}

/** Flatten a DSH content-block list into plain text. */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') continue;
    else if (block.type === 'image') continue; // carried separately, not flattened
    else if (block.type === 'file') parts.push('[文件]');
    else if (block.type === 'tool-call') continue;
  }
  return parts.join('\n').trim();
}

/**
 * The extension the upload endpoint associates with one media type.
 *
 * The endpoint judges the file type by the filename EXTENSION — the browser
 * always sends one — so a name without an extension (or with one that
 * disagrees with `mediaType`) is rejected as "unsupported file type" even
 * though the bytes themselves are fine.
 *
 * @param {string} mediaType
 */
function imageExtension(mediaType) {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'png';
}

/**
 * Extensions the upload endpoint understands, keyed by media type.
 *
 * Used only when a document arrives without a filename extension; a name that
 * already ends with something is kept as is, because the endpoint decides the
 * type from it.
 */
const DOCUMENT_EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/html': 'html',
  'application/zip': 'zip',
});

/**
 * Media type guessed from a filename, for documents arriving without one.
 *
 * The DSH file reference carries a name but no media type (verbatim files are
 * type-agnostic in the attachment store), so the upload's Content-Type comes
 * from the extension. An unknown extension becomes a binary stream.
 *
 * @param {string | undefined} name
 * @returns {string}
 */
export function mediaTypeForName(name) {
  const match = typeof name === 'string' ? name.match(/\.([A-Za-z0-9]{1,8})$/u) : null;
  const ext = match === null ? '' : match[1].toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'pdf': return 'application/pdf';
    case 'doc': return 'application/msword';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls': return 'application/vnd.ms-excel';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt': return 'application/vnd.ms-powerpoint';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'txt': return 'text/plain';
    case 'md': return 'text/markdown';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'html':
    case 'htm': return 'text/html';
    case 'zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

/**
 * The filename one upload carries.
 *
 * The DSH attachment's display name is kept when it already ends with the
 * right extension; anything else (no name, no extension, or a mismatched one —
 * a `.png` name on WebP bytes happens when a file is saved renamed) is
 * replaced by a generated name, because the endpoint type-checks by extension.
 *
 * @param {string | undefined} name
 * @param {string} mediaType
 */
function uploadFileName(name, mediaType) {
  const ext = imageExtension(mediaType);
  if (typeof name === 'string' && name.toLowerCase().endsWith(`.${ext}`)) return name;
  return `image.${ext}`;
}

/**
 * The filename one document upload carries.
 *
 * Unlike images there is no canonical extension to compare against, so a name
 * that already has ANY extension is trusted (the endpoint is the authority on
 * what it accepts); a nameless or extensionless file gets one from its media
 * type.
 *
 * @param {string | undefined} name
 * @param {string} mediaType
 */
function documentFileName(name, mediaType) {
  const base = typeof name === 'string' && name.trim() !== '' ? name.trim().replace(/[\\/]/gu, '_') : '';
  if (/\.([A-Za-z0-9]{1,8})$/u.test(base)) return base;
  const ext = DOCUMENT_EXTENSIONS[mediaType] ?? 'bin';
  return base === '' ? `file.${ext}` : `${base}.${ext}`;
}

/**
 * The text a file-only or image-only turn sends.
 *
 * The web completion endpoint requires a non-empty prompt, and an attachment
 * without a caption is still a question. Naming the files keeps the request
 * self-describing without leaking a local path.
 *
 * @param {ReadonlyArray<{ name?: string, mediaType?: string }>} refs
 */
function attachmentPrompt(refs) {
  const names = refs.map((ref) => {
    const raw = typeof ref?.name === 'string' && ref.name !== ''
      ? ref.name
      : (typeof ref?.mediaType === 'string' && ref.mediaType.startsWith('image/') ? '图片' : '附件');
    const safe = raw.replace(/[\\/]/gu, '_').replace(/[\u0000-\u001f\u007f]/gu, '').trim();
    return safe.length > 120 ? `${safe.slice(0, 120)}…` : safe;
  });
  const text = `请查看附件：${names.join('、')}`;
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Every distinct document reference in one message list, in message order.
 *
 * A file block carries a `FileAttachmentRef` (`attachmentId`, `name`, digest
 * facts) with no media type — verbatim files are type-agnostic in the store —
 * so the media type is derived from the name at upload time.
 *
 * @param {ReadonlyArray<object>} messages
 * @returns {Array<{ attachmentId: string, name: string }>}
 */
export function fileRefs(messages) {
  const refs = [];
  const seen = new Set();
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'file') continue;
      const ref = block.attachment;
      if (ref === null || typeof ref !== 'object') continue;
      const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : '';
      const name = typeof ref.name === 'string' && ref.name.trim() !== '' ? ref.name.trim() : '';
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      refs.push({ attachmentId: id, name });
    }
  }
  return refs;
}

/**
 * Every distinct image reference in one message list, in message order.
 *
 * The web endpoint takes images as `ref_file_ids` — ids of files uploaded
 * beforehand — so the adapter needs the references themselves, not a text
 * rendering of them. A reference is the DSH `ImageBlock.attachment` minus its
 * display name, and it must keep EVERY verification field (`bytes`, `width`,
 * `height`): the attachment store's `readImage` re-reads the stored object and
 * rejects a reference whose recorded facts do not match the bytes, and a
 * trimmed `{attachmentId, mediaType}` ref made every image turn fail with
 * "Stored attachment metadata does not match its reference" (byteLength never
 * equals `undefined`). The bytes themselves are fetched through the attachment
 * service at upload time, not carried in the message.
 *
 * @param {ReadonlyArray<object>} messages
 * @returns {Array<{ attachmentId: string, mediaType: string, bytes?: number, width?: number, height?: number, name?: string }>}
 */
export function imageRefs(messages) {
  const refs = [];
  const seen = new Set();
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'image') continue;
      const ref = block.attachment;
      if (ref === null || typeof ref !== 'object') continue;
      const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : '';
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      refs.push({
        attachmentId: id,
        mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png',
        bytes: typeof ref.bytes === 'number' ? ref.bytes : undefined,
        width: typeof ref.width === 'number' ? ref.width : undefined,
        height: typeof ref.height === 'number' ? ref.height : undefined,
        name: typeof ref.name === 'string' && ref.name !== '' ? ref.name : undefined,
      });
    }
  }
  return refs;
}

/**
 * Openings that mark a user-role message as harness bookkeeping.
 *
 * The loop splits its runtime context across MULTIPLE user-role messages, not
 * one: the environment block starts with `Current runtime context.`, and a
 * separate trailing message carries the clock and time zone starting with
 * `Time sampled while preparing turn …`. Recognizing only the first block let
 * that clock stanza through as if the human had typed it — which then became the
 * opening message of the web conversation.
 *
 * @type {readonly string[]}
 */
const INJECTION_PREFIXES = Object.freeze([
  'Current runtime context.',
  'Time sampled while preparing',
  'Browser time zone for this request:',
  'Elapsed since the preceding',
  'Current working directory:',
  'Current DSH file policy:',
  'Approval policy:',
  'You are the Team Lead named',
  'Current DeepSeek Harness implementation checkout:',
  'Current DeepSeek Harness Web GUI URL:',
  'Use list_agents(',
  'Use send_message(',
  'Use update_goal',
  'Use create_goal',
  '<system-reminder>',
  '<available_skills>',
  '<conversation>',
]);

/** Phrases that only appear in harness bookkeeping, used when no prefix matches. */
const INJECTION_MARKERS = Object.freeze([
  'This snapshot supersedes earlier runtime-context snapshots',
  'Browser time zone for this request',
  'Elapsed since the preceding',
  'Current DeepSeek Harness implementation checkout',
  '<system-reminder>',
  '<available_skills>',
]);

/**
 * Whether a message carries something a human said.
 *
 * The session log tags every user-role message with a `source.kind`, and only
 * `'user'` means the person typed it. The loop inserts its own bookkeeping under
 * other kinds — `runtime-context` (environment block), `time-context` (the clock
 * and time zone), `skill-catalog` (the skill list), `user-approval` (a policy
 * change notice), `subagent-settled` (a delegation notice) — and those must not
 * be forwarded to the web product.
 *
 * A message with no source at all is request-only input, which is human by
 * construction.
 *
 * @param {any} message
 */
export function isHumanMessage(message) {
  const kind = message?.source?.kind;
  if (kind === undefined || kind === null) return true;
  return kind === 'user';
}

/**
 * Whether one user-role message is harness machinery rather than something the
 * human typed.
 *
 * This is the content-level fallback used when a message carries no usable
 * source tag. `isHumanMessage` is the primary check.
 *
 * @param {string} text
 */
export function isHarnessInjection(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return true;
  for (const prefix of INJECTION_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  // Fallback for a stanza whose opening is unknown but whose body is clearly
  // bookkeeping. Two independent markers is specific enough not to catch a real
  // question that merely mentions one of these phrases.
  let hits = 0;
  for (const marker of INJECTION_MARKERS) {
    if (trimmed.includes(marker)) hits += 1;
  }
  return hits >= 2;
}

/**
 * Whether one text is the host's projected file handle rather than a human
 * caption.
 *
 * DSH 0.2.x projects every `FileBlock` into deterministic text before an
 * adapter is called. The text contains the local read-only path, so it must
 * never be forwarded to the web product. It can still identify the original
 * message, whose raw log entry carries the attachment reference.
 *
 * @param {string} text
 */
export function hasProjectedFileHandle(text) {
  if (typeof text !== 'string' || !text.includes('[File "')) return false;
  // Match the stable header of every DSH file handle, in both forms: the
  // path-bearing `):` form and the `) was uploaded, but ...` form used when the
  // current execution environment cannot expose a readable path. Not the
  // trailing prose: that is a sentence and may change. False positives (a
  // human literally typing such a header) fail closed rather than risking a
  // local path or a silent loss of attachment.
  return /\[File "[^"]+" \(\d+ bytes, sha256:[0-9a-f]+\)(?:[: ]|$)/u.test(text);
}

/**
 * Extract the human caption and durable file references from a raw session
 * message (the pre-projection form).
 *
 * @param {object | null | undefined} message
 * @returns {{ text: string, files: Array<{ attachmentId: string, name: string }> }}
 */
export function projectUserMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return { text: parts.join('\n').trim(), files: fileRefs([{ content }]) };
}

/**
 * Whether one message content list carries an attachment block.
 *
 * A user can send only an image (no text); that message is still a real prompt
 * and must not be skipped as though it were empty.
 *
 * @param {unknown} content
 */
function hasAttachmentBlock(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'image' || block?.type === 'file');
}

/**
 * The newest human message, even when it carries only an attachment.
 *
 * @param {ReadonlyArray<object>} messages
 * @returns {{ id: string | null, text: string, message: object } | null}
 */
export function newestHumanMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (!isHumanMessage(message)) continue;
    const text = blocksToText(message.content);
    if (text !== '' && isHarnessInjection(text)) continue;
    if (text === '' && !hasAttachmentBlock(message.content)) continue;
    return { id: message.id ?? null, text, message };
  }
  return null;
}

/**
 * The newest user message a human actually typed, with its flattened text.
 *
 * Kept as a text-only view for callers that need a prompt or a title. The
 * adapter itself uses {@link newestHumanMessage} so an image-only turn is not
 * mistaken for a repeat of the previous question.
 *
 * @param {ReadonlyArray<object>} messages
 * @returns {{ id: string | null, text: string } | null}
 */
export function newestRealUser(messages) {
  const newest = newestHumanMessage(messages);
  if (newest === null || newest.text === '') return null;
  return { id: newest.id, text: newest.text };
}

/**
 * Answer one auxiliary request locally.
 *
 * `session-title` wants a short label and `compaction` wants a condensed digest;
 * neither needs the web product, and routing them there would spend the user's
 * web quota and litter the web sidebar with synthetic conversations such as
 * "Session title generation".
 *
 * @param {{ purpose?: string, messages: ReadonlyArray<object> }} options
 */
async function* localAnswer(options) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const text = options.purpose === 'session-title' ? deriveTitle(messages) : deriveDigest(messages);
  yield { type: 'block-start', index: 0, blockType: 'text' };
  if (text !== '') yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** A short title taken from the first thing the human typed. */
function deriveTitle(messages) {
  const first = newestRealUser(messages);
  if (first === null) return '';
  return titleFromPrompt(first.text);
}

/**
 * The title both sides show, derived from one user message.
 * @param {string} text
 */
export function titleFromPrompt(text) {
  const line = String(text).split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '';
  const cleaned = line.replace(/^[#>*\-\s]+/u, '').replace(/["'“”「」]/gu, '').trim();
  return cleaned.length > 32 ? `${cleaned.slice(0, 32)}…` : cleaned;
}

/** A compact digest of the human turns, used when the loop asks for compaction. */
function deriveDigest(messages) {
  const lines = [];
  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const text = blocksToText(message.content);
    if (text === '' || isHarnessInjection(text)) continue;
    const label = message.role === 'user' ? '用户' : '助手';
    const body = text.replace(/\s+/gu, ' ').trim();
    lines.push(`${label}：${body.length > 160 ? `${body.slice(0, 160)}…` : body}`);
    if (lines.length >= 12) break;
  }
  return lines.join('\n');
}

/**
 * Streams DeepSeek web replies as harness chunks.
 */
export class DeepSeekWebAdapter {
  /**
   * @param {{
   *   api: import('./api.js').DeepSeekWebApi,
   *   resolveBinding: (sessionId: string) => { chatSessionId: string, parentMessageId: number | null, seeded: boolean } | undefined,
   *   bindSession: (sessionId: string, binding: { chatSessionId: string, parentMessageId: number | null, seeded: boolean }) => void,
   *   updateBinding: (sessionId: string, patch: { parentMessageId?: number | null }) => void,
   *   noteSent: (sessionId: string, messageId: string) => boolean,
   *   onExchange?: (sessionId: string, chatSessionId: string, userText: string, assistantText: string, reasoning: string) => void,
   *   recoverUserMessage?: (sessionId: string, messageId: string) => object | null,
   *   warn?: (message: string) => void,
   * }} dependencies
   */
  constructor(dependencies) {
    this.deps = dependencies;
  }

  /** @param {string} provider */
  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek 网页版' };
  }

  /** A resolved policy, not a fragment: the scheduler reads these fields directly. */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'POW_UNSOLVED']),
      initialDelayMs: 800,
      maxDelayMs: 6000,
      jitterRatio: 0.2,
    });
  }

  /**
   * Provider-side request-image pricing.
   *
   * The web product meters images on its own side (the upload reply carries
   * `token_usage`), so DSH's meter should treat every retained occurrence as
   * "model-visible, unknown cost" rather than estimating from pixels: the web
   * endpoint never receives raw image bytes from us, only an id.
   *
   * @param {string} _provider
   * @param {string} _model
   */
  imageRequestPricing(_provider, _model) {
    return {
      priceImages: (images) =>
        images.map(({ offloaded }) => ({
          visualTokens: 0,
          text: offloaded === true ? '' : '[image uploaded to the web conversation]',
        })),
    };
  }

  /** @param {string} provider */
  async listModels(provider) {
    return MODELS.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      // Images ride along as uploaded file references (`ref_file_ids`); the web
      // product itself offers image input on every chat model.
      inputModalities: ['text', 'image'],
    }));
  }

  /**
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    const entry = modelRow(model);
    return {
      provider,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 8192,
    };
  }

  /**
   * @param {string} provider
   * @param {string} model
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return {
      model: resolved,
      stream: (options) => this.stream({ ...options, provider, model }),
    };
  }

  /**
   * Re-read the web conversation's latest message id when the binding may be stale.
   *
   * The web side moves independently: the user can keep talking on
   * chat.deepseek.com between DSH turns. Sending the next prompt with an old
   * `parent_message_id` asks the model to answer a branch that no longer contains
   * those turns. Refreshing costs one small GET, so it is throttled: within a
   * continuous exchange our own replies already advance the recorded id.
   *
   * A failure here must not block the turn — a stale parent still produces a
   * usable answer, just one that may be missing the web-side turns.
   *
   * @param {{ chatSessionId?: string, parentMessageId?: number | null, parentSyncedAt?: number }} binding
   */
  async refreshParent(binding) {
    const chatSessionId = binding?.chatSessionId;
    if (typeof chatSessionId !== 'string' || chatSessionId === '') return binding;
    const last = Number(binding.parentSyncedAt) || 0;
    // Imported sessions are checked on every turn: a stale parent can strand
    // web-side turns that arrived moments ago, and there is no import ledger to
    // repair that after the anchor moves.
    if (binding.origin !== 'imported' && Date.now() - last < PARENT_STALE_MS) return binding;
    try {
      const history = await this.deps.api.getHistory(chatSessionId);
      if (history === null) {
        return binding.origin === 'imported'
          ? { ...binding, pendingImport: 'missing', parentSyncedAt: Date.now() }
          : binding;
      }
      const latest = lastMessageId(history.messages);
      const syncedAt = Date.now();
      if (latest !== null && latest !== binding.parentMessageId) {
        // An imported session owns a DSH log that already contains its earlier
        // turns. Appending cannot run while the session is live, and silently
        // moving the parent past the unseen turns would lose them forever.
        // Only settled, appendable turns may be described as "wait for the
        // append"; an unfinished question/reply needs a different instruction
        // because no append can make progress on it.
        if (binding.origin === 'imported') {
          const planned = planAppend(history.messages, {
            afterMessageId: binding.parentMessageId,
          });
          let pendingImport;
          if (!planned.ok) {
            pendingImport = planned.reason === 'anchor-missing'
              ? 'anchor-missing'
              : planned.reason === 'no-anchor' ? 'no-anchor' : 'terminal';
          } else if (planned.turns > 0) {
            pendingImport = 'appendable';
          } else {
            // No settled turn can be appended. A trailing question or WIP
            // reply may still settle; a terminal failure never will.
            const last = history.messages[history.messages.length - 1];
            const status = typeof last?.status === 'string' ? last.status.toUpperCase() : '';
            const inProgress = String(last?.role ?? '').toUpperCase() === 'USER'
              || status === 'WIP'
              || status === '';
            pendingImport = inProgress ? 'unfinished' : 'terminal';
          }
          return { ...binding, pendingImport, parentSyncedAt: syncedAt };
        }
        // A local web conversation has no import ledger; continue from the tail.
        return { ...binding, parentMessageId: latest, parentSyncedAt: syncedAt };
      }
      return { ...binding, parentSyncedAt: syncedAt };
    } catch {
      return binding.origin === 'imported'
        ? { ...binding, pendingImport: 'unverified', parentSyncedAt: Date.now() }
        : binding;
    }
  }

  /**
   * Stream one reply.
   *
   * @param {{
   *   provider: string, model: string,
   *   messages: ReadonlyArray<object>, system?: string, purpose?: 'compaction' | 'session-title',
   *   signal?: AbortSignal, sessionId?: string,
   * }} options
   * @returns {AsyncIterable<object>} harness `StreamChunk` values.
   */
  async *stream(options) {
    // The loop also drives auxiliary calls — title generation and compaction —
    // through this same adapter. Forwarding them to the web product would mint a
    // throwaway conversation per DSH session (visible in the web sidebar as
    // "Session title generation" and friends) and would bill the user's web
    // quota for harness bookkeeping. Answer them locally instead.
    if (options.purpose === 'session-title' || options.purpose === 'compaction') {
      yield* localAnswer(options);
      return;
    }

    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    const entry = modelRow(options.model);
    const messages = Array.isArray(options.messages) ? options.messages : [];

    // The prompt is exactly the newest human message — never the system prompt,
    // never earlier turns, never injected context. The web conversation keeps
    // its own history, so re-sending the transcript would duplicate it and drag
    // harness internals into the user's chats. An imported conversation already
    // holds its history on the web side.
    const newest = newestHumanMessage(messages);
    let prompt = newest?.text ?? '';
    if (newest === null) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    // A host-projected FileBlock reaches us as text containing the local
    // read-only path. Recover the raw message from the live session instead of
    // forwarding that path; if recovery is impossible, fail closed.
    /** @type {Array<{ attachmentId: string, name: string }>} */
    let documents = fileRefs([newest.message]);
    if (hasProjectedFileHandle(prompt)) {
      let raw = null;
      try {
        raw = sessionId === undefined || newest.id === null
          ? null
          : this.deps.recoverUserMessage?.(sessionId, String(newest.id)) ?? null;
      } catch (error) {
        raw = null;
      }
      const recovered = raw === null ? null : projectUserMessage(raw);
      if (recovered === null || recovered.files.length === 0) {
        const error = new DeepSeekWebError(
          'deepseek-web: 附件原文无法从当前会话恢复，已阻止发送；请改用快捷侧问面板上传该文件',
          'FILE_RECOVERY',
          { submitted: false },
        );
        yield finishError(error);
        return;
      }
      prompt = recovered.text;
      documents = recovered.files;
    }

    // One turn may re-enter the adapter; only a genuinely new user message is a
    // new request. A repeat returns an empty stop so the loop is not re-prompted.
    if (sessionId !== undefined && newest.id !== null) {
      const fresh = this.deps.noteSent(sessionId, String(newest.id));
      if (!fresh) {
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
    }

    // Resolve or mint the web conversation.
    let binding = sessionId === undefined ? undefined : this.deps.resolveBinding(sessionId);
    if (binding === undefined) {
      try {
        const created = await this.deps.api.createSession();
        binding = {
          chatSessionId: created.id,
          parentMessageId: null,
          seeded: false,
          // Immutable provenance. `seeded` flips to true after the first completed
          // reply, so it records "has conversed here", not "where this came from".
          // Undo needs the latter: a conversation the user started in DSH must
          // keep its log, and that fact cannot change just because it was used.
          origin: 'local',
          parentSyncedAt: Date.now(),
        };
        if (sessionId !== undefined) this.deps.bindSession(sessionId, binding);
      } catch (error) {
        // Nothing reached the model: there is no conversation yet, so a retry of
        // this same message must be allowed to try again. Without this the turn
        // would be swallowed forever after one transient failure.
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
        yield finishError(error);
        return;
      }
    } else {
      binding = await this.refreshParent(binding);
      if (binding.pendingImport !== undefined) {
        // Nothing was sent. The web side is ahead of this imported session, and
        // only a close-time append can bring it back in sync.
        const pending = {
          appendable: {
            code: 'IMPORT_PENDING',
            message: 'deepseek-web: 网页端有尚未追加到本会话的新轮次；请先离开并重新打开本会话，等插件完成追加后再发送',
          },
          unfinished: {
            code: 'IMPORT_UNFINISHED',
            message: 'deepseek-web: 网页端还有未完成的提问或回复；请先在网页端等待其完成，再离开并重新打开本会话',
          },
          'anchor-missing': {
            code: 'IMPORT_ANCHOR_MISSING',
            message: 'deepseek-web: 网页端历史已变化，找不到上次同步的位置；请在设置页撤销导入后重新同步',
          },
          terminal: {
            code: 'IMPORT_TERMINAL',
            message: 'deepseek-web: 网页端最后一条回复以失败/超时状态结束，追加无法修复；请在设置页撤销导入后重新同步',
          },
          'no-anchor': {
            code: 'IMPORT_NO_ANCHOR',
            message: 'deepseek-web: 本会话没有可用的网页端锚点；请在设置页撤销导入后重新同步',
          },
          missing: {
            code: 'IMPORT_MISSING',
            message: 'deepseek-web: 网页端对话已不存在或不可读；请在设置页撤销导入后重新同步',
          },
          unverified: {
            code: 'IMPORT_UNVERIFIED',
            message: 'deepseek-web: 暂时无法确认网页端最新状态，为避免丢消息已阻止发送；请稍后重试',
          },
        }[binding.pendingImport] ?? {
          code: 'IMPORT_PENDING',
          message: 'deepseek-web: 网页端有尚未同步的内容；请先离开并重新打开本会话',
        };
        const error = new DeepSeekWebError(pending.message, pending.code, { submitted: false });
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
        yield finishError(error);
        return;
      }
    }

    // Upload this turn's images, if any, before the completion POST. The web
    // endpoint takes images as `ref_file_ids` — ids from a prior upload — so
    // nothing model-visible happens until the completion call itself. Every
    // failure here is therefore `submitted: false`: the turn may retry whole.
    //
    // Only the newest human message is scanned: DSH passes the complete
    // conversation history on every call, and re-uploading every historical
    // image would attach old pictures to each new question.
    /** @type {string[]} */
    let refFileIds = [];
    const refs = imageRefs([newest.message]);
    if (refs.length > 0) {
      const readImage = this.deps.readImage;
      if (typeof readImage !== 'function') {
        const error = new Error('deepseek-web: image input needs the attachment service, which is unavailable');
        error.submitted = false;
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
        yield finishError(error);
        return;
      }
      try {
        for (const ref of refs) {
          const stored = await readImage(ref);
          const fileId = await this.deps.api.uploadImage({
            bytes: stored.data,
            mediaType: ref.mediaType,
            fileName: uploadFileName(ref.name, ref.mediaType),
            thinking: entry.thinking,
            signal: options.signal,
          });
          refFileIds.push(fileId);
        }
      } catch (error) {
        // Nothing reached the model — uploads precede the completion POST.
        error.submitted = false;
        // The failure surfaces to the user as a bare turn error; log the cause
        // here so the Host log shows WHY the upload did not go through.
        this.deps.warn?.(
          `deepseek-web: image upload failed before the prompt was sent (${error instanceof Error ? error.message : String(error)})`,
        );
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
        yield finishError(error);
        return;
      }
    }

    // Documents ride the same upload path with the `file` model type. Their
    // bytes come verbatim out of the attachment store; the prompt keeps a
    // filename fallback so a file-only turn still has a non-empty prompt.
    // `documents` was resolved above, either from this message or from the raw
    // session message when the host had projected the file into handle text.
    if (documents.length > 0) {
      const readFileBytes = this.deps.readFileBytes;
      if (typeof readFileBytes !== 'function') {
        const error = new Error('deepseek-web: file input needs the attachment service, which is unavailable');
        error.submitted = false;
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
        yield finishError(error);
        return;
      }
      try {
        for (const ref of documents) {
          const bytes = await readFileBytes(ref);
          const mediaType = mediaTypeForName(ref.name);
          const fileId = await this.deps.api.uploadFile({
            bytes,
            mediaType,
            fileName: documentFileName(ref.name, mediaType),
            // A generic file whose name happens to be an image still needs the
            // vision route, or the server parses it as a document.
            modelType: mediaType.startsWith('image/') ? 'vision' : 'file',
            thinking: entry.thinking,
            signal: options.signal,
          });
          refFileIds.push(fileId);
        }
      } catch (error) {
        // Nothing reached the model — uploads precede the completion POST.
        error.submitted = false;
        this.deps.warn?.(
          `deepseek-web: file upload failed before the prompt was sent (${error instanceof Error ? error.message : String(error)})`,
        );
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
        yield finishError(error);
        return;
      }
    }

    // An attachment-only turn still needs a non-empty prompt. The names are
    // taken from the references, never from a local path.
    if (prompt.trim() === '' && (refs.length > 0 || documents.length > 0)) {
      prompt = attachmentPrompt([...refs, ...documents]);
    }
    if (prompt.trim() === '') {
      // A malformed attachment block (no usable id/name) must not be marked as
      // sent and then silently stop: release the dedup memo and report it.
      this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'deepseek-web: the newest message has no usable text or attachment', code: 'EMPTY_PROMPT' },
        },
      };
      return;
    }

    let reasoningIndex = -1;
    let textIndex = -1;
    let reasoningText = '';
    let answerText = '';
    let nextIndex = 0;
    let messageId = null;
    let reasoningClosed = false;
    /** A terminal server-side status must not be reported as a successful empty/partial reply. */
    let remoteFailure = null;
    /** Usage is emitted after both blocks close, so the assembler sees a settled transcript. */
    let pendingUsage = null;

    try {
      for await (const event of this.deps.api.streamCompletion({
        chatSessionId: binding.chatSessionId,
        prompt,
        parentMessageId: binding.parentMessageId,
        thinking: entry.thinking,
        search: entry.search === true,
        refFileIds,
        signal: options.signal,
      })) {
        if (event.kind === 'message') {
          messageId = event.messageId;
          continue;
        }
        if (event.kind === 'status') {
          const status = String(event.status ?? '');
          if (/FAILED|ERROR|CANCEL|ABORT/u.test(status)) {
            remoteFailure = new DeepSeekWebError(
              `deepseek-web: the web product ended the reply with status ${status || 'unknown'}`,
              'REMOTE_FAILED',
              { submitted: true },
            );
            break;
          }
          continue;
        }
        if (event.kind === 'fragment' && event.text !== '') {
          if (event.fragmentType === 'THINK') {
            if (reasoningIndex < 0) {
              reasoningIndex = nextIndex++;
              reasoningText = '';
              yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
            }
            reasoningText += event.text;
            yield { type: 'reasoning-delta', index: reasoningIndex, text: event.text };
          } else {
            // Closing the reasoning block before the answer keeps the two
            // block lifetimes non-overlapping, which the assembler requires.
            if (reasoningIndex >= 0 && !reasoningClosed) {
              reasoningClosed = true;
              yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } };
            }
            if (textIndex < 0) {
              textIndex = nextIndex++;
              answerText = '';
              yield { type: 'block-start', index: textIndex, blockType: 'text' };
            }
            answerText += event.text;
            yield { type: 'text-delta', index: textIndex, text: event.text };
          }
          continue;
        }
        if (event.kind === 'tokens' && event.total > 0) {
          pendingUsage = { inputTokens: 0, outputTokens: event.total, totalTokens: event.total };
          continue;
        }
        if (event.kind === 'done') break;
      }
    } catch (error) {
      // A failure before the completion POST reached the server (no challenge,
      // unsolved PoW, connection refused, request timeout) leaves nothing to
      // duplicate, so this message may be retried. Once it is submitted the answer
      // is unknown and a retry could make the model reply twice, so the marker is
      // kept in that case.
      if (error?.submitted === false) {
        this.deps.forgetSent?.(sessionId, newest.id === null ? '' : String(newest.id));
      }
      yield finishError(error);
      return;
    }

    if (reasoningIndex >= 0 && !reasoningClosed) {
      reasoningClosed = true;
      yield {
        type: 'block-end',
        index: reasoningIndex,
        block: { type: 'reasoning', text: reasoningText },
      };
    }
    if (textIndex >= 0) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: answerText } };
    }
    if (pendingUsage !== null) {
      yield { type: 'usage', usage: pendingUsage };
    }

    if (remoteFailure !== null) {
      yield finishError(remoteFailure);
      return;
    }
    if (textIndex < 0 && reasoningIndex < 0) {
      yield finishError(new DeepSeekWebError(
        'deepseek-web: the web product returned no visible text or reasoning',
        'EMPTY_RESPONSE',
        { submitted: true },
      ));
      return;
    }

    if (sessionId !== undefined) {
      const wasSeeded = binding.seeded === true;
      // One binding write per turn: `bindSession` persists the complete record,
      // so a separate parent patch would only queue a second full-state write.
      const next = { ...binding, seeded: true, parentMessageId: messageId ?? binding.parentMessageId, parentSyncedAt: Date.now() };
      this.deps.bindSession(sessionId, next);
      // The web product titles a conversation from its first exchange, which for
      // a Chinese conversation comes back as an English paraphrase. Renaming it to
      // the same text DSH uses keeps one name on both sides. An empty
      // conversation refuses the rename, so this runs only after the reply
      // settled.
      if (!wasSeeded) {
        try {
          await this.deps.api.renameSession(binding.chatSessionId, titleFromPrompt(prompt));
        } catch (error) {
          this.deps.warn?.(`deepseek-web: could not rename the web conversation: ${String(error)}`);
        }
      }
      try {
        this.deps.onExchange?.(sessionId, binding.chatSessionId, prompt, answerText, reasoningText);
      } catch (error) {
        this.deps.warn?.(`deepseek-web: exchange hook failed: ${String(error)}`);
      }
    }

    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/**
 * Map a transport failure onto a terminal `finish` chunk.
 *
 * The harness validates every chunk as lossless JSON, and its walker rejects an
 * object graph containing an `undefined` property value — a `status: undefined`
 * here would replace the real failure with "Assistant stream chunk must be
 * losslessly JSON-serializable". Optional fields are therefore omitted, never
 * set to `undefined`.
 */
function finishError(error) {
  const isWeb = error instanceof DeepSeekWebError;
  const failure = {
    message: error instanceof Error ? error.message : String(error),
    code: isWeb ? error.code : 'TRANSPORT',
  };
  if (isWeb && error.status !== undefined) failure.status = error.status;
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure,
    },
  };
}
