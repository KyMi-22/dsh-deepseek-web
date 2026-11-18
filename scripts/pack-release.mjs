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
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
  throw new Error('package.json has no name/version');
}
if (/[\s/\\]/u.test(manifest.name)) throw new Error(`unsafe package name: ${manifest.name}`);

await mkdir(dist, { recursive: true });
const npmCli = process.env.npm_execpath;
const command = npmCli === undefined
  ? (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  : process.execPath;
const args = npmCli === undefined
  ? ['pack', '--pack-destination', dist]
  : [npmCli, 'pack', '--pack-destination', dist];
const output = execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
if (output === '') throw new Error('npm pack returned no artifact name');

const tarball = join(dist, output.split(/\r?\n/u).at(-1));
const hash = createHash('sha256');
for await (const chunk of createReadStream(tarball)) hash.update(chunk);
const digest = hash.digest('hex');
const checksum = `${tarball}.sha256`;
await writeFile(checksum, `${digest}  ${output.split(/\r?\n/u).at(-1)}\n`, 'utf8');

console.log(`packed ${output}`);
console.log(`sha256 ${digest}`);
console.log(`artifact ${tarball}`);
console.log(`checksum ${checksum}`);
