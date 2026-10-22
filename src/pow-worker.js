// Worker entry: solve one PoW challenge off the main thread.
//
// The solver is a tight CPU loop (about a second at the current difficulty). Run
// on the Host's thread it stalls every other session, the settings page and any
// in-flight sync for that whole second — noticeable at any pace, painful when the
// user is chatting continuously.
import { parentPort, workerData } from 'node:worker_threads';

import { solvePow } from './pow.js';

try {
  const answer = solvePow(workerData.challenge, { budgetMs: workerData.budgetMs });
  parentPort?.postMessage({ ok: true, answer });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
