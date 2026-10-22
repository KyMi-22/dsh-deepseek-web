// Off-thread proof-of-work solving, with a safe fallback.
//
// `solvePow` is a synchronous CPU loop. In the Host process that blocks the event
// loop for roughly a second per turn, which stalls other sessions, the settings
// page, and any synchronization in flight. At a high message rate that is the
// dominant source of jank, so the work is pushed to a worker thread.
//
// A worker may be unavailable (a restricted runtime, a bundler that cannot resolve
// the entry, a platform without worker_threads). In that case the solver falls
// back to the in-process loop: slower for everything else, but never broken. The
// fallback is reported so the caller can log it once instead of silently losing
// the benefit.
//
// One worker per solve. The alternative — a reused thread — saves about 30-50 ms
// of startup but must then answer "what happens to queued callers when it dies
// mid-solve", and a half-dead pool is a worse failure than a slower start.
import { Worker } from 'node:worker_threads';

import { solvePow } from './pow.js';

/** Marks a failure that means "no worker here", not "this challenge failed". */
export const POW_WORKER_UNAVAILABLE = 'POW_WORKER_UNAVAILABLE';

/**
 * Solve a challenge without blocking the event loop.
 *
 * @param {object} challenge - the `challenge` object from `create_pow_challenge`.
 * @param {{ signal?: AbortSignal, budgetMs?: number }} [options]
 * @returns {Promise<{ answer: number | undefined, offThread: boolean }>}
 * @throws {Error} when the algorithm is unknown or the attempt is aborted.
 */
export async function solvePowOffThread(challenge, options = {}) {
  const { signal, budgetMs = 60_000 } = options;
  if (challenge?.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`unsupported PoW algorithm: ${challenge?.algorithm}`);
  }
  if (signal?.aborted) throw new Error('PoW solve aborted');

  let worker;
  try {
    // The challenge travels in `workerData`: the worker can start solving without
    // a message round-trip, and there is no window where it waits for input.
    worker = new Worker(new URL('./pow-worker.js', import.meta.url), {
      workerData: { challenge, budgetMs },
    });
  } catch {
    // No worker support here: keep working, just on this thread.
    return { answer: solvePow(challenge, { signal, budgetMs }), offThread: false };
  }
  worker.unref();

  try {
    const answer = await runWorker(worker, { signal });
    return { answer, offThread: true };
  } catch (error) {
    if (error?.code === POW_WORKER_UNAVAILABLE) {
      return { answer: solvePow(challenge, { signal, budgetMs }), offThread: false };
    }
    throw error;
  } finally {
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {Worker} worker
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<number | undefined>}
 */
function runWorker(worker, { signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      fn(value);
    };
    const onMessage = (message) => {
      if (message?.ok === true) done(resolve, message.answer);
      else done(reject, new Error(message?.error ?? 'PoW worker failed'));
    };
    const onError = (error) => {
      // The thread itself failed to load or died: report it as "no worker" so the
      // caller can retry in-process instead of failing the turn.
      done(reject, Object.assign(new Error('PoW worker failed'), {
        code: POW_WORKER_UNAVAILABLE,
        cause: error,
      }));
    };
    const onAbort = () => done(reject, new Error('PoW solve aborted'));

    worker.once('message', onMessage);
    worker.once('error', onError);
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  });
}
