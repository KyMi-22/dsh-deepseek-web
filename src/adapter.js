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
import { lastMessageId } from './sync.js';

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
 * A plausible filename for one media type.
 *
 * The upload endpoint stores whatever name it is given and the web UI shows it;
 * the DSH attachment ref usually has none, so a stable extension keeps the
 * conversation's file list readable.
 *
 * @param {string} mediaType
 */
function guessImageName(mediaType) {
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'png';
  return `image.${ext}`;
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
 * The newest user message a human actually typed.
 *
 * @param {ReadonlyArray<object>} messages
 * @returns {{ id: string | null, text: string } | null}
 */
export function newestRealUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (!isHumanMessage(message)) continue;
    const text = blocksToText(message.content);
    if (text === '') continue;
    if (isHarnessInjection(text)) continue;
    return { id: message.id ?? null, text };
  }
  return null;
}

/**
 * The prompt the web endpoint receives.
 *
 * Exactly the newest human message — never the system prompt, never earlier
 * turns, never injected context. The web conversation keeps its own history, so
 * re-sending the transcript would duplicate it and drag harness internals into
 * the user's chats. A session whose first turn is the first human message needs
 * nothing older, and an imported conversation already holds its history on the
 * web side.
 *
 * @param {ReadonlyArray<object>} messages
 */
function buildPrompt(messages) {
  return newestRealUser(messages)?.text ?? '';
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
   * Stream one reply.
   *
   * @param {{
   *   provider: string, model: string,
   *   messages: ReadonlyArray<object>, system?: string, purpose?: 'compaction' | 'session-title',
   *   signal?: AbortSignal, sessionId?: string,
   * }} options
   * @returns {AsyncIterable<object>} harness `StreamChunk` values.
   */
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
    if (Date.now() - last < PARENT_STALE_MS) return binding;
    try {
      const history = await this.deps.api.getHistory(chatSessionId);
      if (history === null) return binding;
      const latest = lastMessageId(history.messages);
      const syncedAt = Date.now();
      if (latest !== null && latest !== binding.parentMessageId) {
        // Branch moved on without us; continue from the real tail.
        return { ...binding, parentMessageId: latest, parentSyncedAt: syncedAt };
      }
      return { ...binding, parentSyncedAt: syncedAt };
    } catch {
      return binding;
    }
  }

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

    const newest = newestRealUser(messages);
    if (newest === null) {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    const prompt = buildPrompt(messages);
    if (prompt === '') {
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
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
    }

    // Upload the turn's images, if any, before the completion POST. The web
    // endpoint takes images as `ref_file_ids` — ids from a prior upload — so
    // nothing model-visible happens until the completion call itself. Every
    // failure here is therefore `submitted: false`: the turn may retry whole.
    /** @type {string[]} */
    let refFileIds = [];
    const refs = imageRefs(messages);
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
            fileName: ref.name ?? guessImageName(ref.mediaType),
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

    let reasoningIndex = -1;
    let textIndex = -1;
    let reasoningText = '';
    let answerText = '';
    let nextIndex = 0;
    let messageId = null;
    let reasoningClosed = false;
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

    if (sessionId !== undefined) {
      const wasSeeded = binding.seeded === true;
      // Our own reply is now the tail of the web thread, so the parent is fresh.
      this.deps.updateBinding(sessionId, { parentMessageId: messageId, parentSyncedAt: Date.now() });
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
