// Credential persistence: serialization, and the commit boundary.
//
// Two distinct hazards, both about the same thing — `state.token` is candidate
// state during a save, while the file on disk holds the committed state:
//
//   1. Serialization. Two concurrent saves are read-modify-write on shared state.
//      A failing save that restores its snapshot after a newer save already
//      persisted would leave disk and memory disagreeing.
//
//   2. Commit boundary. A background write (a binding, a ledger row) queued during
//      a save must never persist the candidate. Otherwise a rejected credential
//      still lands on disk, and the next launch starts with a token the plugin
//      explicitly refused.
//
// Writes are injected rather than provoked with filesystem errors: renaming against
// an occupied path succeeds or fails depending on platform and the antivirus
// indexer, which made this suite flaky with EPERM.
//
//   node test/token-serial.test.mjs

import assert from 'node:assert';

import { StateStore } from '../src/store.js';

const DISK_FULL = new Error('disk full');

/** A store over an in-memory disk, with a controllable writer. */
function makeStore(options = {}) {
  const state = {
    token: 'OLD',
    deviceId: 'd',
    bindings: {},
    imported: {},
    workspaceId: null,
    lastSyncAt: 0,
    syncPausedUntil: 0,
    lastSyncError: null,
    lastWorkspaceError: null,
    lastReport: null,
  };
  /** Every token value that reached the fake disk, in order. */
  const written = [];
  const store = new StateStore(state, {
    persist: async (snapshot) => {
      const failure = options.failWhen?.(snapshot, written.length);
      if (failure !== undefined) throw failure;
      written.push(snapshot.token);
    },
  });
  return { store, written };
}

// ── 1. a failed save rolls back and a later save wins ─────────────────────
{
  const { store, written } = makeStore({
    failWhen: (snapshot) => (snapshot.token === 'AAA' ? DISK_FULL : undefined),
  });

  const first = store.setToken('AAA').then(
    () => 'ok',
    () => 'rejected',
  );
  const second = store.setToken('BBB');

  assert.equal(await first, 'rejected', 'the first save failed');
  await second;

  assert.equal(store.token, 'BBB', 'memory holds the value that reached the disk');
  assert.deepEqual(written, ['BBB'], 'only the accepted value was written');
  assert.equal(written[written.length - 1], store.token, 'memory and disk agree');
}

// ── 2. a background write queued BEFORE the save cannot carry the candidate ─
{
  const { store, written } = makeStore({
    failWhen: (snapshot) => (snapshot.token === 'CANDIDATE' ? DISK_FULL : undefined),
  });

  store.setBinding('s1', { chatSessionId: 'w1', seeded: true, origin: 'imported' });
  const save = store.setToken('CANDIDATE').then(
    () => 'ok',
    () => 'rejected',
  );

  assert.equal(await save, 'rejected', 'the credential save was rejected');
  await store.queue;

  assert.equal(written.includes('CANDIDATE'), false, 'the rejected candidate never reached the disk');
  assert.equal(store.token, 'OLD', 'memory was rolled back');
  assert.equal(store.token, written[written.length - 1], 'memory and disk agree');
}

// ── 3. a background write queued DURING the save cannot carry the candidate ─
{
  // The reported case. Timing matters and is easy to get wrong, so it is driven
  // explicitly:
  //   - the credential write blocks on a gate, so the save cannot finish early;
  //   - a bookkeeping write is queued behind it while the candidate is still live;
  //   - releasing the gate fails the credential write, then lets the bookkeeping
  //     write run for real.
  // The bookkeeping write is therefore the one that decides whether the rejected
  // candidate reaches the disk.
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let gated = false;

  const state = {
    token: 'OLD',
    deviceId: 'd',
    bindings: {},
    imported: {},
    workspaceId: null,
    lastSyncAt: 0,
    syncPausedUntil: 0,
    lastSyncError: null,
    lastWorkspaceError: null,
    lastReport: null,
  };
  const written = [];
  const store = new StateStore(state, {
    persist: async (snapshot) => {
      if (!gated && snapshot.token === 'CANDIDATE') {
        gated = true;
        await gate;
        throw DISK_FULL;
      }
      written.push(snapshot.token);
    },
  });

  const save = store.setToken('CANDIDATE').then(
    () => 'ok',
    () => 'rejected',
  );

  // Let the credential write reach the gate and occupy the queue.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gated, true, 'the credential write is suspended mid-flight');

  // Queue the bookkeeping write while the candidate is still in `state.token`.
  store.setBinding('s2', { chatSessionId: 'w2', seeded: true, origin: 'imported' });
  store.recordImported({ chatSessionId: 'w2', dshSessionId: 's2', updatedAt: 0, messageCount: 0 });

  releaseGate();
  assert.equal(await save, 'rejected', 'the credential save was rejected');
  await store.queue;

  assert.equal(written.includes('CANDIDATE'), false, 'the candidate never reached the disk');
  assert.ok(written.length > 0, 'the bookkeeping writes did run');
  assert.deepEqual([...new Set(written)], ['OLD'], 'every bookkeeping write persisted the committed token');
  assert.equal(store.token, 'OLD', 'memory was rolled back');
  assert.equal(store.token, written[written.length - 1], 'memory and disk agree');
}

// ── 4. a successful save commits, and later writes keep writing it ─────────
{
  const { store, written } = makeStore({});

  await store.setToken('NEW');
  assert.equal(store.token, 'NEW');
  assert.equal(store.committedToken, 'NEW', 'the committed value advanced');

  store.setBinding('s3', { chatSessionId: 'w3', seeded: true, origin: 'imported' });
  await store.queue;
  assert.equal(written[written.length - 1], 'NEW', 'background writes keep the accepted token');
}

// ── 5. a rejected save does not disturb a later accepted one ──────────────
{
  let attempts = 0;
  const { store, written } = makeStore({
    failWhen: () => {
      attempts += 1;
      return attempts === 1 ? DISK_FULL : undefined;
    },
  });

  const rejected = store.setToken('FIRST').then(
    () => 'ok',
    () => 'rejected',
  );
  const accepted = store.setToken('SECOND');

  assert.equal(await rejected, 'rejected');
  await accepted;

  assert.equal(store.token, 'SECOND');
  assert.equal(store.committedToken, 'SECOND');
  assert.equal(written[written.length - 1], 'SECOND');
  assert.equal(written.includes('FIRST'), false, 'the rejected value never reached the disk');
}

console.log('token-serial.test.mjs: all assertions passed');
