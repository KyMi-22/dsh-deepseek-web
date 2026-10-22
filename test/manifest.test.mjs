// The manifest gate from .github/workflows/ci.yml, runnable locally.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const fail = (message) => {
  console.error('FAIL:', message);
  process.exit(1);
};

const exported = pkg.exports ?? {};
for (const [key, value] of Object.entries(exported)) {
  if (key.includes('*')) continue;
  const target = typeof value === 'string' ? value : value.default;
  if (!target) continue;
  if (!fs.existsSync(path.resolve(target))) fail(`exports["${key}"] -> ${target} is missing`);
}

const icon = exported['./icon'];
if (!icon) fail('./icon export missing');
const iconPath = path.resolve(typeof icon === 'string' ? icon : icon.default);
const bytes = fs.readFileSync(iconPath);
if (bytes.length > 256 * 1024) fail(`icon is ${bytes.length} bytes, over the 256 KiB limit`);
const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
const svg = bytes.toString('utf8', 0, 200).includes('<svg');
if (!png && !jpeg && !webp && !svg) fail('icon is not a recognised image format');

for (const locale of fs.readdirSync('locale')) {
  const doc = JSON.parse(fs.readFileSync(path.join('locale', locale), 'utf8'));
  if (!doc.meta?.title) fail(`locale/${locale} has no meta.title`);
  if (!doc.meta?.description) fail(`locale/${locale} has no meta.description`);
}

// Every file the manifest promises to ship must exist.
for (const entry of pkg.files ?? []) {
  const target = path.resolve(entry);
  if (!fs.existsSync(target)) fail(`files entry "${entry}" does not exist`);
}

console.log('manifest ok:', pkg.name, pkg.version);
void execFileSync;
