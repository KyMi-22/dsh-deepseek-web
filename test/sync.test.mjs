// Offline tests for the lifecycle operations: title mirroring, the import window
// and ordering, attaching imported sessions to the workspace, and undoing an
// import completely.
//
//   node test/sync.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachSessions,
  nextSyncDelayMs,
  planTitlePush,
  resolveSyncWindowStart,
  selectImportBatch,
  titleFromSessionEvent,
  undoImports,
} from '../src/sync.js';

const DAY = 86_400_000;

// ── auto-sync scheduling is jittered, not metronomic ──────────────────────
{
  const BASE = 300;

  // Deterministic spread: the same base must not always produce the same delay.
  const lows = nextSyncDelayMs(BASE, () => 0);
  const highs = nextSyncDelayMs(BASE, () => 1);
  const mid = nextSyncDelayMs(BASE, () => 0.5);
  assert.equal(lows, BASE * 0.7 * 1000, 'the lower bound is 70% of the mean');
  assert.equal(highs, BASE * 1.3 * 1000, 'the upper bound is 130% of the mean');
  assert.equal(mid, BASE * 1000, 'the middle of the range is the mean');
  assert.notEqual(lows, highs, 'the delay is not a single fixed value');

  // Every sampled delay stays inside the band and is a sane millisecond count.
  for (let i = 0; i < 200; i += 1) {
    const delay = nextSyncDelayMs(BASE);
    assert.ok(Number.isInteger(delay), 'a whole number of milliseconds');
    assert.ok(delay >= BASE * 0.7 * 1000 - 1, 'never below the band');
    assert.ok(delay <= BASE * 1.3 * 1000 + 1, 'never above the band');
  }

  // Auto-sync off, and degenerate configuration.
  assert.equal(nextSyncDelayMs(0), 0, 'zero means manual-only');
  assert.equal(nextSyncDelayMs(-5), 0, 'a negative interval disables scheduling');
  assert.equal(nextSyncDelayMs(Number.NaN), 0, 'a non-numeric interval disables scheduling');

  // A very short mean is floored, so a misconfiguration cannot hammer the service.
  // Both bounds are asserted deterministically — comparing a random draw against a
  // fixed number would make this test pass about half the time and hide regressions.
  assert.equal(nextSyncDelayMs(1, () => 0), 1000, 'the floor lifts a sub-second mean to 1s');
  assert.equal(nextSyncDelayMs(1, () => 1), 1300, 'the ceiling still applies above the floor');
}

// ── title events ───────────────────────────────────────────────────────────
{
  assert.equal(titleFromSessionEvent({ type: 'session/title', data: { title: '新名字' } }), '新名字');
  assert.equal(titleFromSessionEvent({ type: 'session/title', data: { title: '  含空格  ' } }), '含空格');
  assert.equal(titleFromSessionEvent({ type: 'session/title', data: { title: '   ' } }), null, 'blank is ignored');
  assert.equal(titleFromSessionEvent({ type: 'session/title', data: {} }), null);
  assert.equal(titleFromSessionEvent({ type: 'user/message', data: { title: 'x' } }), null, 'other events are ignored');
  assert.equal(titleFromSessionEvent(null), null);
}

// ── planning a title push ──────────────────────────────────────────────────
{
  const bindings = new Map([
    ['dsh-1', { chatSessionId: 'web-1', parentMessageId: 2, seeded: true }],
    ['dsh-2', { chatSessionId: '', parentMessageId: null, seeded: false }],
  ]);
  const resolve = (id) => bindings.get(id);

  const planned = planTitlePush({ type: 'session/title', data: { title: '重命名后的标题' } }, 'dsh-1', resolve);
  assert.deepEqual(planned, { chatSessionId: 'web-1', title: '重命名后的标题' }, 'a bound session maps to its web conversation');

  assert.equal(planTitlePush({ type: 'session/title', data: { title: 'x' } }, 'unbound', resolve), null, 'no binding means nothing to rename');
  assert.equal(planTitlePush({ type: 'session/title', data: { title: 'x' } }, 'dsh-2', resolve), null, 'an empty web id is not a target');
  assert.equal(planTitlePush({ type: 'session/title', data: { title: '  ' } }, 'dsh-1', resolve), null, 'blank titles are not pushed');
  assert.equal(planTitlePush({ type: 'user/message', data: {} }, 'dsh-1', resolve), null, 'only title events matter');
  assert.equal(planTitlePush({ type: 'session/title', data: { title: 'x' } }, undefined, resolve), null, 'a missing session id is not pushed');
  // A throwing resolver must not break the event feed.
  assert.equal(
    planTitlePush({ type: 'session/title', data: { title: 'x' } }, 'dsh-1', () => { throw new Error('boom'); }),
    null,
  );
}

// ── the import window ──────────────────────────────────────────────────────
{
  const now = new Date('2026-10-22T10:54:20+08:00').getTime(); // a Thursday

  const weekStart = resolveSyncWindowStart('week', now);
  const week = new Date(weekStart);
  assert.equal(week.getDay(), 1, 'the week starts on Monday (local time)');
  assert.equal(week.getHours(), 0, 'at local midnight');
  assert.equal(week.getMinutes(), 0);
  assert.equal(week.getSeconds(), 0);
  assert.ok(weekStart <= now, 'the window starts in the past');
  assert.ok(weekStart > now - 7 * DAY, 'and no further back than a week');

  assert.equal(resolveSyncWindowStart('all', now), 0, "'all' keeps everything");
  assert.equal(resolveSyncWindowStart(undefined, now), 0, 'an absent window keeps everything');
  assert.equal(resolveSyncWindowStart(3, now), now - 3 * DAY, 'a number means trailing days');

  const monthStart = new Date(resolveSyncWindowStart('month', now));
  assert.equal(monthStart.getDate(), 1, 'the month starts on the 1st');
  assert.equal(monthStart.getHours(), 0, 'at local midnight');
}

// ── batch selection: window filter, oldest first ──────────────────────────
{
  const now = Date.now();
  const sessions = [
    { id: 'ancient', updatedAt: (now - 30 * DAY) / 1000 },
    { id: 'recent', updatedAt: (now - 1 * DAY) / 1000 },
    { id: 'mid', updatedAt: (now - 2 * DAY) / 1000 },
  ];
  const batch = selectImportBatch(sessions, now - 7 * DAY);
  assert.deepEqual(
    batch.map((entry) => entry.id),
    ['mid', 'recent'],
    'only in-window conversations, oldest first so the newest ends up on top',
  );

  const everything = selectImportBatch(sessions, 0);
  assert.deepEqual(
    everything.map((entry) => entry.id),
    ['ancient', 'mid', 'recent'],
    'a zero window keeps all of them, still oldest first',
  );

  // A session with a missing timestamp is out of any bounded window.
  assert.equal(selectImportBatch([{ id: 'x' }], now - 7 * DAY).length, 0);
  // …but survives an unbounded one.
  assert.equal(selectImportBatch([{ id: 'x' }], 0).length, 1);
}

// ── conversations already bound to a DSH session are not re-imported ──────
{
  const now = Date.now();
  const sessions = [
    { id: 'imported-before', updatedAt: (now - 3 * DAY) / 1000 },
    { id: 'bound-to-local', updatedAt: (now - 2 * DAY) / 1000 },   // created by a new DSH session
    { id: 'brand-new', updatedAt: (now - 1 * DAY) / 1000 },
  ];
  const bound = new Set(['bound-to-local']);

  const batch = selectImportBatch(sessions, now - 7 * DAY, bound);
  assert.deepEqual(
    batch.map((entry) => entry.id),
    ['imported-before', 'brand-new'],
    'a conversation already bound to a DSH session is skipped, so no duplicate appears',
  );

  // Omitting the set keeps the previous behaviour.
  assert.equal(selectImportBatch(sessions, now - 7 * DAY).length, 3);
}

// ── attachSessions ─────────────────────────────────────────────────────────
{
  const attached = [];
  const workspace = {
    async attachSession(id) {
      if (id === 'boom') throw new Error('header unreadable');
      attached.push(id);
    },
  };
  const warnings = [];
  const result = await attachSessions(workspace, ['a', 'b', 'boom', 'c'], (m) => warnings.push(m));
  assert.deepEqual(attached, ['a', 'b', 'c'], 'every readable session is attached');
  assert.equal(result.attached, 3);
  assert.equal(result.failed, 1, 'one failure is counted, not fatal');
  assert.equal(warnings.length, 1, 'the failure is reported');
}

// A workspace without the method must not throw.
{
  const warnings = [];
  const result = await attachSessions({}, ['a'], (m) => warnings.push(m));
  assert.equal(result.attached, 0);
  assert.equal(warnings.length, 1);
}

// ── undoImports ────────────────────────────────────────────────────────────
{
  // Build a fake home so the real session store is never touched.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-undo-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const directory = path.join(home, 'deepseek-web', 'conversations');
  fs.mkdirSync(directory, { recursive: true });

  // The slug the store derives from that directory.
  const slug = `--${directory.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`;
  const sessionsRoot = path.join(home, 'sessions', slug);

  const ids = ['sess-one', 'sess-two', 'sess-missing'];
  for (const id of ids.slice(0, 2)) {
    fs.mkdirSync(path.join(sessionsRoot, id), { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, id, 'session.v4.jsonl.zstd'), 'x');
  }

  // An OLD install could pollute the ledger with conversations that were started
  // in DSH (the adapter used to record them there for deduplication). Undo must
  // not delete those: the binding's `seeded: false` is what says "local".
  const pollutedId = 'sess-local-but-in-ledger';
  fs.mkdirSync(path.join(sessionsRoot, pollutedId), { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, pollutedId, 'session.v4.jsonl.zstd'), 'mine');

  const imported = Object.fromEntries([
    ...ids.map((id) => [id, { chatSessionId: id, dshSessionId: id }]),
    [pollutedId, { chatSessionId: 'web-mine', dshSessionId: pollutedId }],
  ]);
  const bindings = {
    [pollutedId]: { chatSessionId: 'web-mine', parentMessageId: 4, seeded: false },
  };

  // Record the ORDER of registry calls: archiving must happen before the files
  // are deleted, because archiving reads each session's stored header.
  const order = [];
  const registry = {
    async archiveSession(id) {
      if (id === 'sess-missing') throw new Error('no such session');
      order.push(`archive:${id}`);
    },
    async delete(id) {
      order.push(`delete:${id}`);
    },
  };

  // The directory also holds a conversation STARTED in DSH: it has no import
  // record, yet it must be archived too or it falls into the ungrouped bucket
  // once the workspace is gone. Its log must survive.
  const localId = 'sess-local-started-in-dsh';
  fs.mkdirSync(path.join(sessionsRoot, localId), { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, localId, 'session.v4.jsonl.zstd'), 'local');

  const query = {
    async filterSessions(filters) {
      assert.deepEqual(filters, [{ kind: 'cwd', values: [directory] }], 'sessions are found by directory');
      return [
        ...ids.map((id) => ({ header: { id }, live: false, persisted: true })),
        { header: { id: localId }, live: false, persisted: true },
        { header: { id: pollutedId }, live: false, persisted: true },
      ];
    },
  };

  const warnings = [];
  const report = await undoImports({
    imported,
    workspaceId: 'ws-1',
    directory,
    registry,
    query,
    bindings,
    warn: (m) => warnings.push(m),
  });

  assert.equal(report.archivedSessions, 4, 'two ledger imports, the DSH-started one, and the polluted ledger entry are archived');
  assert.equal(report.archiveFailed, 1, 'an unarchivable one is counted, not fatal');
  assert.equal(report.archivedLocal, 2, 'both non-imported conversations are reported as local');
  assert.equal(report.keptLocal, 1, 'the locally started conversation keeps its log');
  assert.equal(report.removedSessions, 3, 'the three real ledger imports are cleared (removal is idempotent)');
  assert.equal(report.failedSessions, 0, 'a missing directory is not a failure');
  assert.equal(report.workspaceDeleted, true);
  // The caller keeps the ledger rows it could not clean up, so a retry is possible.
  assert.deepEqual(report.failedSessionIds, ['sess-missing'], 'the unarchivable ledger entry is reported back');

  // The P1 regression: a conversation started in DSH must survive an undo, even
  // when an older build wrote it into the import ledger.
  assert.equal(
    fs.existsSync(path.join(sessionsRoot, pollutedId, 'session.v4.jsonl.zstd')),
    true,
    'a locally started conversation keeps its log despite being in the ledger',
  );

  // Archive first, then delete the workspace: that ordering is what keeps the
  // undo from dropping the sessions into the ungrouped bucket. Ledger entries
  // come first (they seed the id set), then anything the directory scan adds.
  assert.deepEqual(
    order,
    ['archive:sess-one', 'archive:sess-two', `archive:${pollutedId}`, `archive:${localId}`, 'delete:ws-1'],
    'every session under the directory is archived before the workspace goes',
  );
  assert.ok(order.indexOf('delete:ws-1') > order.lastIndexOf(`archive:${localId}`), 'workspace deletion comes last');

  assert.equal(fs.existsSync(path.join(sessionsRoot, 'sess-one')), false, 'sess-one is gone');
  assert.equal(fs.existsSync(path.join(sessionsRoot, 'sess-two')), false, 'sess-two is gone');
  assert.equal(
    fs.existsSync(path.join(sessionsRoot, localId)),
    true,
    'a conversation the user started in DSH keeps its log',
  );

  // Undo with no workspace id must still archive and remove sessions.
  fs.mkdirSync(path.join(sessionsRoot, 'sess-three'), { recursive: true });
  const again = await undoImports({
    imported: { 'sess-three': { dshSessionId: 'sess-three' } },
    workspaceId: null,
    directory,
    registry,
    warn: () => {},
  });
  assert.equal(again.archivedSessions, 1);
  assert.equal(again.removedSessions, 1);
  assert.equal(again.workspaceDeleted, false);

  // Without an archive capability the undo degrades to deletion and says so.
  {
    const warnings2 = [];
    const bare = await undoImports({
      imported: { 'sess-four': { dshSessionId: 'sess-four' } },
      workspaceId: null,
      directory,
      registry: {},
      warn: (m) => warnings2.push(m),
    });
    assert.equal(bare.archivedSessions, 0);
    assert.equal(bare.archiveFailed, 1, 'the missing archive capability is reported');
    assert.equal(bare.removedSessions, 1, 'files are still cleaned up');
    // Two independent degradations: no directory listing and no archive capability.
    assert.equal(warnings2.length, 2, 'both reduced capabilities are reported');
  }

  // Without sessionQuery the undo still archives what the ledger knows about.
  {
    const warnings3 = [];
    const ledgerOnly = await undoImports({
      imported: { 'sess-five': { dshSessionId: 'sess-five' } },
      workspaceId: null,
      directory,
      registry,
      warn: (m) => warnings3.push(m),
    });
    assert.equal(ledgerOnly.archivedSessions, 1);
    assert.equal(ledgerOnly.archivedLocal, 0);
    assert.equal(warnings3.length, 1, 'the reduced scope is reported');
  }

  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('sync.test.mjs: all assertions passed');
