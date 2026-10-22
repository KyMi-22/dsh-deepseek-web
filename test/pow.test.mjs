// Offline tests for the proof-of-work solver.
//
// This is the riskiest algorithm in the package: `DeepSeekHashV1` is a bespoke
// Keccak variant (lanes swap their 32-bit halves, 23 rounds), so a refactor that
// "simplifies" it toward standard SHA3-256 would still produce plausible-looking
// hex and simply stop being accepted by the server. The vector below is a real
// challenge the service issued, together with the answer this implementation
// produced for it — a behavioural pin, not a self-consistency check.
//
//   node test/pow.test.mjs

import assert from 'node:assert';
import { solvePowOffThread } from '../src/pow-async.js';
import { DeepSeekHash, powResponseHeader, solvePow } from '../src/pow.js';

// ── a real challenge/answer pair from chat.deepseek.com ────────────────────
//
// These long hex strings are the PoW PUZZLE the service issued and its
// signature — not credentials. They carry no identity, grant no access, are
// already solved, and the challenge has expired; keeping them is what lets this
// test detect an algorithm drift. No account token appears anywhere in this
// package.
const VECTOR = {
  algorithm: 'DeepSeekHashV1',
  challenge: '9ca9fc17745e8c1460f548a87b58ab31e06c2d0dc1ffa0a37992a62a3f66b57e',
  salt: '2a373e0ac0abd6a48b2f',
  signature: '04e9faf462d489f20a6a8fbb89ea52baf1e600a451d44b6b881e717f1d4f7882',
  difficulty: 144000,
  expire_at: 1792644590455,
  expire_after: 300000,
  target_path: '/api/v0/chat/completion',
};
const VECTOR_ANSWER = 121636;

{
  const started = Date.now();
  const answer = solvePow(VECTOR);
  const elapsed = Date.now() - started;
  assert.equal(answer, VECTOR_ANSWER, 'the solver must reproduce the answer the live service accepted');
  console.log(`  live vector solved: answer=${answer} in ${elapsed}ms`);
}

// ── the off-thread path really runs on a worker ───────────────────────────
{
  // The whole point is that the Host's event loop stays free; if the worker
  // silently degrades to the in-process loop every turn stalls for a second and
  // nothing says so. `offThread` is the observable proof it did not degrade.
  const started = Date.now();
  const { answer, offThread } = await solvePowOffThread(VECTOR);
  const elapsed = Date.now() - started;

  assert.equal(answer, VECTOR_ANSWER, 'the worker reproduces the same answer');
  assert.equal(offThread, true, 'the solve ran on a worker thread, not the main one');
  console.log(`  off-thread vector solved: answer=${answer} in ${elapsed}ms (worker)`);

  // The event loop must remain responsive while the worker computes. A timer
  // scheduled before the await fires before the solve resolves.
  let ticked = false;
  const tick = setTimeout(() => { ticked = true; }, 0);
  await solvePowOffThread(VECTOR);
  clearTimeout(tick);
  assert.equal(ticked, true, 'the event loop kept running during the solve');
}

// ── aborting an off-thread solve stops it ─────────────────────────────────
{
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => solvePowOffThread(VECTOR, { signal: controller.signal }),
    /aborted/u,
    'an already-aborted signal is honoured before starting',
  );
}

// ── self-consistency on a synthetic challenge ─────────────────────────────
{
  // Build a challenge whose answer is known by construction: hash the prefix
  // followed by "0" and publish that as the digest.
  const salt = 'testsalt';
  const expireAt = 1700000000000;
  const prefix = `${salt}_${expireAt}_`;
  const hasher = new DeepSeekHash().writeAscii(prefix).writeAscii('0');
  const digest = hasher.digestHex();

  const synthetic = {
    algorithm: 'DeepSeekHashV1',
    challenge: digest,
    salt,
    signature: 'sig',
    difficulty: 8,
    expire_at: expireAt,
    target_path: '/api/v0/chat/completion',
  };
  assert.equal(solvePow(synthetic), 0, 'an answer of 0 is found immediately');
}

// ── the digest is deterministic and 32 bytes of hex ───────────────────────
{
  const a = new DeepSeekHash().writeAscii('abc').digestHex();
  const b = new DeepSeekHash().writeAscii('abc').digestHex();
  assert.equal(a, b, 'the same input yields the same digest');
  assert.match(a, /^[0-9a-f]{64}$/u, 'a 32-byte lowercase hex digest');
  const c = new DeepSeekHash().writeAscii('abd').digestHex();
  assert.notEqual(a, c, 'a different input yields a different digest');

  // Reusing one instance must behave like a fresh one, because the solver
  // resets and reuses a single hasher across candidates.
  const reused = new DeepSeekHash();
  reused.reset().writeAscii('abc').digestHex();
  reused.reset().writeAscii('abc');
  assert.equal(reused.digestHex(), a, 'reset restores the initial state');
}

// ── edges ─────────────────────────────────────────────────────────────────
{
  // Zero difficulty has no candidates.
  assert.equal(
    solvePow({ ...VECTOR, difficulty: 0 }),
    undefined,
    'a zero difficulty search finds nothing',
  );

  // An unknown algorithm is a hard error, not a silent failure.
  assert.throws(
    () => solvePow({ ...VECTOR, algorithm: 'SomethingElse' }),
    /unsupported PoW algorithm/u,
    'an unknown algorithm is rejected',
  );

  // The abort signal stops the search.
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => solvePow(VECTOR, { signal: controller.signal }), /aborted/u, 'abort is honoured');
}

// ── the header payload the server receives ────────────────────────────────
{
  const header = powResponseHeader(VECTOR, VECTOR_ANSWER);
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.deepEqual(decoded, {
    algorithm: VECTOR.algorithm,
    challenge: VECTOR.challenge,
    salt: VECTOR.salt,
    answer: VECTOR_ANSWER,
    signature: VECTOR.signature,
    target_path: VECTOR.target_path,
  }, 'the header carries exactly the fields the service checks');
}

console.log('pow.test.mjs: all assertions passed');
