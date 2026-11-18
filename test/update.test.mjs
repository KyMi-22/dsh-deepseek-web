/**
 * Self-update helpers: version comparison and release metadata.
 *
 *   node test/update.test.mjs
 */

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, downloadRelease, latestRelease, parseVersion } from '../src/update.js';

// ── versions ───────────────────────────────────────────────────────────────
{
  assert.deepEqual(parseVersion('0.5.0'), [0, 5, 0]);
  assert.deepEqual(parseVersion('v0.5.0'), [0, 5, 0], 'the tag prefix is accepted');
  assert.deepEqual(parseVersion('v1.2.3-rc.1'), [1, 2, 3], 'a pre-release suffix is ignored');
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(undefined), null);

  assert.equal(compareVersions('0.5.0', '0.4.1'), 1);
  assert.equal(compareVersions('v0.4.1', '0.4.1'), 0);
  assert.equal(compareVersions('0.4.0', '0.4.1'), -1);
  // Numeric, not lexical: 0.10.0 is newer than 0.9.0.
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('nope', '0.1.0'), null, 'an unparsable side has no verdict');
}

// ── release metadata ───────────────────────────────────────────────────────
{
  const json = {
    tag_name: 'v0.6.0',
    html_url: 'https://github.com/x/y/releases/tag/v0.6.0',
    published_at: '2026-10-27T00:00:00Z',
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt', size: 10, digest: 'sha256:aa' },
      { name: 'dsh-deepseek-web-0.6.0.tgz', browser_download_url: 'https://example.com/pkg.tgz', size: 4242, digest: 'sha256:' + 'ab'.repeat(32) },
    ],
  };
  const release = await latestRelease({
    repo: 'x/y',
    fetchImpl: async (url) => {
      assert.ok(String(url).endsWith('/repos/x/y/releases/latest'), 'asks the latest-release endpoint');
      return { ok: true, text: async () => JSON.stringify(json) };
    },
  });
  assert.equal(release.version, '0.6.0', 'the leading v is stripped');
  assert.equal(release.tag, 'v0.6.0');
  assert.equal(release.releaseUrl, json.html_url);
  assert.equal(release.asset.name, 'dsh-deepseek-web-0.6.0.tgz', 'the tgz asset is chosen');
  assert.equal(release.asset.size, 4242);
  assert.equal(release.asset.digest, 'sha256:' + 'ab'.repeat(32));
}

{
  // No tgz asset: the caller decides what to do, the parser returns null.
  const release = await latestRelease({
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ tag_name: 'v0.6.0', assets: [] }),
    }),
  });
  assert.equal(release.asset, null);
}

{
  // An HTTP failure surfaces as a readable error, not a JSON crash.
  await assert.rejects(
    () => latestRelease({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) }),
    /HTTP 500/u,
  );
  // A body that is not JSON is reported as such.
  await assert.rejects(
    () => latestRelease({ fetchImpl: async () => ({ ok: true, text: async () => '<html>' }) }),
    /not JSON/u,
  );
}

// ── downloadRelease: digest, size, host and path guards ───────────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'dsw-update-'));
  try {
    const payload = Buffer.from('fake tgz bytes');
    const digest = createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: 'dsh-deepseek-web-0.6.1.tgz',
      url: 'https://github.com/KyMi-22/dsh-deepseek-web/releases/download/v0.6.1/dsh-deepseek-web-0.6.1.tgz',
      size: payload.length,
      digest: `sha256:${digest}`,
    };
    const downloaded = await downloadRelease(asset, {
      dir,
      fetchImpl: async () => new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) },
      }),
    });
    assert.equal(downloaded.bytes, payload.length);
    assert.equal(downloaded.sha256, digest);
    assert.deepEqual(await readFile(downloaded.path), payload);

    await assert.rejects(
      () => downloadRelease({ ...asset, digest: '' }, {
        dir,
        fetchImpl: async () => new Response(payload, { status: 200 }),
      }),
      /no sha256 digest/u,
      'an unsigned asset is refused',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset, name: '../../evil.tgz' }, { dir }),
      /safe tgz basename|escape/u,
      'a traversal-shaped asset name is refused',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset, url: 'https://evil.example/x.tgz' }, { dir }),
      /allowed GitHub host/u,
      'an arbitrary host is refused',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset, size: payload.length + 1 }, {
        dir,
        fetchImpl: async () => new Response(payload, { status: 200 }),
      }),
      /size mismatch/u,
      'the declared size is checked',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset, digest: `sha256:${'0'.repeat(64)}` }, {
        dir,
        fetchImpl: async () => new Response(payload, { status: 200 }),
      }),
      /digest mismatch/u,
      'the digest is checked',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset }, {
        dir,
        fetchImpl: async () => new Response(payload, {
          status: 200,
          headers: { 'content-length': '999999999' },
        }),
      }),
      /too large/u,
      'an oversized declared body is refused',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset }, {
        dir,
        fetchImpl: async () => new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/x.tgz' },
        }),
      }),
      /disallowed host/u,
      'a redirect to an arbitrary host is refused before its body is read',
    );
    await assert.rejects(
      () => downloadRelease({ ...asset }, {
        dir,
        fetchImpl: async () => new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/KyMi-22/dsh-deepseek-web/releases/download/v0.6.1/dsh-deepseek-web-0.6.1.tgz' },
        }),
      }),
      /download answered HTTP 302|redirect/u,
      'a redirect loop is refused',
    );
    const leftovers = await stat(join(dir, `${asset.name}.part`)).catch(() => null);
    assert.equal(leftovers, null, 'no .part file is left behind');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('update.test.mjs: all assertions passed');
