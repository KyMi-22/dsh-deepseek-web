#!/usr/bin/env node
/**
 * Build the release artifact locally.
 *
 * `npm pack` writes the plugin tarball; this script also emits the SHA-256
 * sidecar used by the release workflow and by users who verify a download by
 * hand. It deliberately does not publish anything: GitHub Actions owns that.
 *
 *   npm run release:pack
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
  throw new Error('package.json has no name/version');
}
if (/[\s/\\]/u.test(manifest.name)) throw new Error(`unsafe package name: ${manifest.name}`);
if (!/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error(`unsafe package version: ${manifest.version}`);

await mkdir(dist, { recursive: true });
if (process.env.npm_execpath === undefined && process.platform === 'win32') {
  throw new Error('run this through `npm run release:pack` (Windows cannot spawn npm.cmd directly)');
}
const command = process.env.npm_execpath === undefined ? 'npm' : process.execPath;
const args = process.env.npm_execpath === undefined
  ? ['pack', '--json', '--pack-destination', dist]
  : [process.env.npm_execpath, 'pack', '--json', '--pack-destination', dist];
const raw = execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
let packed;
try {
  const parsed = JSON.parse(raw);
  packed = Array.isArray(parsed) ? parsed[0] : parsed;
} catch {
  throw new Error(`npm pack did not return JSON: ${raw.slice(0, 200)}`);
}
const expectedName = `${manifest.name}-${manifest.version}.tgz`;
if (typeof packed?.filename !== 'string' || basename(packed.filename) !== expectedName) {
  throw new Error(`npm pack produced ${String(packed?.filename)}, expected ${expectedName}`);
}
const output = expectedName;
const tarball = join(dist, output);
const hash = createHash('sha256');
for await (const chunk of createReadStream(tarball)) hash.update(chunk);
const digest = hash.digest('hex');
const checksum = `${tarball}.sha256`;
await writeFile(checksum, `${digest}  ${output}\n`, 'utf8');

console.log(`packed ${output}`);
console.log(`sha256 ${digest}`);
console.log(`artifact ${tarball}`);
console.log(`checksum ${checksum}`);
