// Token save serialization.
//
// `setToken` is read-modify-write on in-memory state, and a failed save rolls the
// value back. With only per-write ordering, save A failing after save B succeeded
// would restore A's snapshot over B's newer value: disk on B, memory on A's
// predecessor, and the next launch disagreeing with the running client.
//
//   node test/token-serial.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateStore, stateFile } from '../src/store.js';

/** A store over a throwaway HOME. */
function freshStore(home) {
  return new StateStore({
    token: '',
    deviceId: 'device',
    bindings: {},
    imported: {},
    workspaceId: null,
    lastSyncAt: 0,
    syncPausedUntil: 0,
    lastSyncError: null,
    lastWorkspaceError: null,
    lastReport: null,
  });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-token-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;

try {
  const store = freshStore(home);
  const target = stateFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Make the FIRST save fail: the rename target is occupied by a directory, so
  // replacing it with the temp file cannot succeed.
  fs.mkdirSync(target, { recursive: true });

  const first = store.setToken('AAA').then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  // Queued behind the first; it must not run until the first has settled.
  const second = store.setToken('BBB');

  const firstResult = await first;
  assert.equal(firstResult.ok, false, 'the first save failed against the blocked path');

  // Clear the obstacle so the queued save can succeed.
  fs.rmSync(target, { recursive: true, force: true });
  await second;

  assert.equal(store.token, 'BBB', 'memory holds the value that actually reached the disk');
  const onDisk = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(onDisk.token, 'BBB', 'and the disk agrees');
  assert.equal(store.token, onDisk.token, 'memory and disk are consistent');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('token-serial.test.mjs: all assertions passed');
