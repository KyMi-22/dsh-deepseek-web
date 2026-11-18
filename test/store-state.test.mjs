/**
 * State-store recovery: a corrupt document is preserved, not silently discarded,
 * and a legacy non-UUID device id is migrated once.
 *
 *   node test/store-state.test.mjs
 */

import assert from 'node:assert';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, stateFile } from '../src/store.js';

const previous = process.env.DSH_HOME;
const home = await mkdtemp(join(tmpdir(), 'dsw-state-'));
process.env.DSH_HOME = home;
try {
  await mkdir(join(home, 'deepseek-web'), { recursive: true });
  await writeFile(stateFile(), '{not json', 'utf8');
  const recovered = await loadState();
  assert.equal(recovered.token, '', 'corrupt state starts from defaults');
  assert.equal(recovered.schemaVersion, 1);
  const files = await readdir(join(home, 'deepseek-web'));
  assert.ok(files.some((name) => name.startsWith('state.json.corrupt-')), 'the corrupt file is preserved for recovery');

  await writeFile(stateFile(), JSON.stringify({
    token: 'old-token',
    deviceId: 'dsh-web-legacy',
    bindings: { s: { chatSessionId: 'c' } },
    imported: { c: { dshSessionId: 's' } },
    quickAsk: null,
    lastReport: null,
  }), 'utf8');
  const migrated = await loadState();
  assert.equal(migrated.token, 'old-token', 'the token survives a valid document');
  assert.match(migrated.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, 'the device id migrates to UUID v4');
  assert.deepEqual(migrated.quickAsk, {}, 'a null map becomes an empty map');
  assert.equal(migrated.lastReport, null);
  assert.ok((await readFile(stateFile(), 'utf8')).includes('dsh-web-legacy'), 'loading does not rewrite the file');
} finally {
  if (previous === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previous;
  await rm(home, { recursive: true, force: true });
}

console.log('store-state.test.mjs: all assertions passed');
