/**
 * Self-update support: release lookup, version comparison and downloads.
 *
 * The settings page's update section is the only caller. Everything here is
 * transport-level: it never installs anything — `index.js` hands the verified
 * file to the plugin manager, which owns the install.
 *
 * GitHub's API answers directly on most networks, but release ASSETS are served
 * from github.com and objects.githubusercontent.com, which some networks reset.
 * When a proxy is configured the download goes through `curl` (Node's fetch
 * only reads proxy settings at process start), otherwise it streams with fetch.
 *
 * @module src/update
 */
'use strict';

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The release host this plugin is published under. */
export const DEFAULT_RELEASE_REPO = 'KyMi-22/dsh-deepseek-web';

/** How long one HTTP request may take before the update reports a timeout. */
const HTTP_TIMEOUT_MS = 60_000;

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Parse a version into its numeric triple.
 *
 * Tags are `v0.5.0`; a trailing pre-release suffix (`-rc.1`) is ignored because
 * only release tags are published. Anything without three numbers is null.
 *
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?\s*$/u.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two version strings numerically.
 *
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1 | null} null when either side is not a version
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index++) {
    if (a[index] === b[index]) continue;
    return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/** One JSON GET. With a proxy it goes through curl, which honors `-x` per call. */
async function getText(url, options = {}) {
  const { proxy = '', signal } = options;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (proxy !== '') {
    const { stdout } = await run('curl', [
      '-fsSL',
      '--max-time', String(Math.ceil(HTTP_TIMEOUT_MS / 1000)),
      '-x', proxy,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'User-Agent: dsh-deepseek-web-updater',
      url,
    ], { windowsHide: true, timeout: HTTP_TIMEOUT_MS + 5_000 });
    return stdout;
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-deepseek-web-updater' },
    signal,
  });
  if (!response.ok) throw new Error(`GitHub API answered HTTP ${response.status}`);
  return await response.text();
}

/**
 * The newest published release.
 *
 * @param {{ repo?: string, proxy?: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ version: string, tag: string, releaseUrl: string, publishedAt: string, asset: { name: string, url: string, size: number, digest: string } | null }>}
 */
export async function latestRelease(options = {}) {
  const repo = options.repo ?? DEFAULT_RELEASE_REPO;
  const text = await getText(`https://api.github.com/repos/${repo}/releases/latest`, options);
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`release metadata was not JSON (${String(error)})`);
  }
  const tag = typeof json?.tag_name === 'string' ? json.tag_name : '';
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const asset = assets.find((entry) => entry !== null && typeof entry === 'object'
    && typeof entry.name === 'string' && entry.name.endsWith('.tgz')) ?? null;
  return {
    version: tag.replace(/^v/u, ''),
    tag,
    releaseUrl: typeof json?.html_url === 'string' ? json.html_url : '',
    publishedAt: typeof json?.published_at === 'string' ? json.published_at : '',
    asset: asset === null ? null : {
      name: asset.name,
      url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      size: Number(asset.size) || 0,
      digest: typeof asset.digest === 'string' ? asset.digest : '',
    },
  };
}

/** Hash one file's bytes. */
async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Stream one URL to a file with fetch; returns the sha256 of what was written. */
async function streamToFile(url, target, signal) {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok) throw new Error(`download answered HTTP ${response.status}`);
  if (response.body === null) throw new Error('download returned no body');
  const hash = createHash('sha256');
  const out = createWriteStream(target);
  const reader = Readable.fromWeb(response.body);
  try {
    await new Promise((resolve, reject) => {
      reader.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      reader.on('data', (chunk) => hash.update(chunk));
      reader.pipe(out);
    });
  } finally {
    reader.destroy();
  }
  return hash.digest('hex');
}

/** Download one URL with curl, which accepts a proxy per invocation. */
async function curlToFile(url, target, proxy) {
  await run('curl', [
    '-fsSL',
    '--retry', '2',
    '--connect-timeout', '20',
    '--max-time', String(Math.ceil(DOWNLOAD_TIMEOUT_MS / 1000)),
    '-x', proxy,
    '-o', target,
    url,
  ], { windowsHide: true, timeout: DOWNLOAD_TIMEOUT_MS + 30_000 });
  return await sha256Of(target);
}

/** The hex form of a GitHub asset digest (`sha256:<hex>`), or ''. */
function digestHex(digest) {
  if (typeof digest !== 'string') return '';
  const match = /^(?:sha256:)?([0-9a-f]{64})$/iu.exec(digest.trim());
  return match === null ? '' : match[1].toLowerCase();
}

/**
 * Download one release asset into `dir` and verify it.
 *
 * Writes to a `.part` file first: a failed or truncated transfer must never
 * leave something that looks installable at the final path. The digest the
 * release carries is checked after the transfer; a missing digest is allowed
 * (older releases), a mismatching one is fatal.
 *
 * @param {{ name: string, url: string, size?: number, digest?: string } | null} asset
 * @param {{ dir: string, proxy?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ path: string, bytes: number, sha256: string }>}
 */
export async function downloadRelease(asset, options) {
  if (asset === null || typeof asset !== 'object' || typeof asset.url !== 'string' || asset.url === '') {
    throw new Error('the release has no downloadable tgz asset');
  }
  const dir = options.dir;
  await mkdir(dir, { recursive: true });
  const name = typeof asset.name === 'string' && asset.name.endsWith('.tgz') ? asset.name : 'dsh-deepseek-web.tgz';
  const target = join(dir, name);
  const partial = `${target}.part`;
  try {
    const proxy = typeof options.proxy === 'string' ? options.proxy : '';
    const sha256 = proxy !== ''
      ? await curlToFile(asset.url, partial, proxy)
      : await streamToFile(asset.url, partial, options.signal);
    const expected = digestHex(asset.digest ?? '');
    if (expected !== '' && expected !== sha256) {
      throw new Error(`download digest mismatch (expected ${expected}, got ${sha256})`);
    }
    const info = await stat(partial);
    if (Number.isFinite(asset.size) && asset.size > 0 && info.size !== asset.size) {
      throw new Error(`download size mismatch (expected ${asset.size} bytes, got ${info.size})`);
    }
    await rename(partial, target);
    return { path: target, bytes: info.size, sha256 };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

/** The plugin's own version, read from its manifest. */
export async function currentVersion() {
  const manifest = new URL('../package.json', import.meta.url);
  const text = await readFile(manifest, 'utf8');
  const json = JSON.parse(text);
  return typeof json.version === 'string' ? json.version : '';
}
