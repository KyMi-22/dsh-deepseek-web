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
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The release host this plugin is published under. */
export const DEFAULT_RELEASE_REPO = 'KyMi-22/dsh-deepseek-web';

/** How long one HTTP request may take before the update reports a timeout. */
const HTTP_TIMEOUT_MS = 60_000;

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Metadata is a small JSON document; refuse an unexpectedly huge body. */
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
/** A plugin tarball is small; this is a disk/DoS guard, not a product limit. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** Hosts that may serve a release asset (GitHub redirects to its object store). */
const ALLOWED_DOWNLOAD_HOSTS = Object.freeze(new Set([
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
]));

/** A release repo must be exactly `owner/name`. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** An asset name must be one safe basename ending in `.tgz`. */
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u;

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

/** A deadline signal, or undefined when the runtime cannot provide one. */
function deadlineSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/** One JSON GET. With a proxy it goes through curl, which honors `-x` per call. */
async function getText(url, options = {}) {
  const { proxy = '', signal } = options;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (proxy !== '') {
    const { stdout } = await run('curl', [
      '-fsSL',
      '--max-time', String(Math.ceil(HTTP_TIMEOUT_MS / 1000)),
      '--max-filesize', String(MAX_METADATA_BYTES),
      '--proto', '=https',
      '-x', proxy,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'User-Agent: dsh-deepseek-web-updater',
      url,
    ], { windowsHide: true, timeout: HTTP_TIMEOUT_MS + 5_000, maxBuffer: MAX_METADATA_BYTES + 1024 });
    if (Buffer.byteLength(stdout) > MAX_METADATA_BYTES) throw new Error('release metadata is unexpectedly large');
    return stdout;
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-deepseek-web-updater' },
    signal: signal === undefined ? deadlineSignal(HTTP_TIMEOUT_MS) : signal,
  });
  if (!response.ok) throw new Error(`GitHub API answered HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error('release metadata is unexpectedly large');
  return text;
}

/**
 * The newest published release.
 *
 * @param {{ repo?: string, proxy?: string, signal?: AbortSignal, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ version: string, tag: string, releaseUrl: string, publishedAt: string, asset: { name: string, url: string, size: number, digest: string } | null }>}
 */
export async function latestRelease(options = {}) {
  const repo = options.repo ?? DEFAULT_RELEASE_REPO;
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) throw new Error('update repo must be an owner/name pair');
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
    && typeof entry.name === 'string' && ASSET_RE.test(entry.name)) ?? null;
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

/**
 * Whether a download URL is one of GitHub's release hosts over HTTPS.
 *
 * The API supplies this URL, so a compromised response must not be able to
 * redirect the plugin to an arbitrary HTTPS endpoint.
 *
 * @param {string} value
 */
function isAllowedDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(url.hostname.toLowerCase());
}

/** Stream one URL to a file with fetch; returns the sha256 of what was written. */
async function streamToFile(url, target, signal, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    signal,
    redirect: 'follow',
    headers: { 'user-agent': 'dsh-deepseek-web-updater' },
  });
  if (!response.ok) throw new Error(`download answered HTTP ${response.status}`);
  if (typeof response.url === 'string' && response.url !== '' && !isAllowedDownloadUrl(response.url)) {
    throw new Error(`download redirected to a disallowed host (${new URL(response.url).hostname})`);
  }
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download is too large (${declared} bytes)`);
  }
  if (response.body === null) throw new Error('download returned no body');
  const hash = createHash('sha256');
  const out = createWriteStream(target);
  const reader = Readable.fromWeb(response.body);
  let written = 0;
  try {
    await new Promise((resolve, reject) => {
      reader.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      reader.on('data', (chunk) => {
        written += chunk.length;
        if (written > MAX_DOWNLOAD_BYTES) {
          reader.destroy(new Error(`download exceeded the ${MAX_DOWNLOAD_BYTES}-byte cap`));
          return;
        }
        hash.update(chunk);
      });
      reader.pipe(out);
    });
  } finally {
    reader.destroy();
    out.destroy();
  }
  return hash.digest('hex');
}

/** Download one URL with curl, which accepts a proxy per invocation. */
async function curlToFile(url, target, proxy) {
  await run('curl', [
    '-fsSL',
    '--proto', '=https',
    '--max-redirs', '5',
    '--retry', '2',
    '--connect-timeout', '20',
    '--max-time', String(Math.ceil(DOWNLOAD_TIMEOUT_MS / 1000)),
    '--max-filesize', String(MAX_DOWNLOAD_BYTES),
    '-x', proxy,
    '-H', 'User-Agent: dsh-deepseek-web-updater',
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
  if (!isAllowedDownloadUrl(asset.url)) throw new Error('the release asset is not hosted on an allowed GitHub host');
  if (typeof asset.name !== 'string' || !ASSET_RE.test(asset.name)) {
    throw new Error('the release asset name is not a safe tgz basename');
  }
  const dir = options.dir;
  await mkdir(dir, { recursive: true });
  const name = asset.name;
  const target = join(dir, name);
  const resolvedDir = resolve(dir);
  if (resolve(target) !== join(resolvedDir, name) || !resolve(target).startsWith(`${resolvedDir}${sep}`)) {
    throw new Error('the release asset would escape the download directory');
  }
  const partial = `${target}.part`;
  try {
    const proxy = typeof options.proxy === 'string' ? options.proxy : '';
    const sha256 = proxy !== ''
      ? await curlToFile(asset.url, partial, proxy)
      : await streamToFile(asset.url, partial, options.signal, options.fetchImpl);
    const expected = digestHex(asset.digest ?? '');
    if (expected === '') {
      throw new Error('the release asset carries no sha256 digest; refusing to install an unverified package');
    }
    if (expected !== sha256) {
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
