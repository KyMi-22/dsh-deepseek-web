// Hygiene gate: cheap invariants that keep the tree clean, checked mechanically.
//
// These are not behaviour tests — they are the things a reviewer would otherwise
// have to notice by eye, and the things that rot silently in a solo project.
//
//   node test/hygiene.test.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** Source files that ship. Tests are checked too, but not for shipping rules. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(rel, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const shipped = ['index.js', 'client.js', ...walk('src')];
const tests = walk('test');

// ── no leftover debugging or abandoned markers ────────────────────────────
{
  // This file is the only one allowed to spell the marker out.
  const self = 'test/hygiene.test.mjs';
  const banned = /(TODO|FIXME|XXX|HACK)\b/;
  for (const file of [...shipped, ...tests]) {
    if (file === self) continue;
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    // `todo_write` is an allowed TOOL NAME, not a marker.
    const lines = src.split('\n').filter((line) => banned.test(line) && !line.includes("'todo_write'"));
    assert.deepEqual(lines, [], `${file} carries a leftover marker`);
  }
}

// ── every import is actually used ─────────────────────────────────────────
{
  for (const file of shipped) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const importRe = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*'([^']+)'/g;
    let match;
    while ((match = importRe.exec(src)) !== null) {
      const names = [];
      if (match[1]) names.push(match[1].trim());
      if (match[2]) {
        for (const part of match[2].split(',')) {
          const cleaned = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (cleaned) names.push(cleaned);
        }
      }
      for (const name of names) {
        // Count occurrences outside the import statement itself.
        const occurrences = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        assert.ok(occurrences > 1, `${file} imports \`${name}\` but never uses it`);
      }
    }
  }
}

// ── modules do not import themselves or form obvious cycles ───────────────
{
  const graph = new Map();
  for (const file of shipped) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    const deps = [...src.matchAll(/from\s*'(\.\/[^']+)'/g)].map((m) => m[1]);
    graph.set(file, deps);
  }
  // A cycle makes module initialisation order load-bearing, which is a trap.
  const seen = new Set();
  const stack = [];
  /** @param {string} file */
  const visit = (file) => {
    if (stack.includes(file)) {
      assert.fail(`import cycle: ${[...stack, file].join(' -> ')}`);
    }
    if (seen.has(file)) return;
    seen.add(file);
    stack.push(file);
    for (const dep of graph.get(file) ?? []) {
      const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(file), dep));
      if (graph.has(normalized)) visit(normalized);
    }
    stack.pop();
  };
  for (const file of graph.keys()) visit(file);
}

// ── files end with a newline and contain no CRLF ──────────────────────────
{
  for (const file of [...shipped, ...tests]) {
    const buf = fs.readFileSync(path.join(root, file));
    assert.equal(buf[buf.length - 1], 0x0a, `${file} does not end with a newline`);
    assert.equal(buf.includes(0x0d), false, `${file} contains CRLF line endings`);
  }
}

// ── documentation covers every shipped module ─────────────────────────────
{
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const file of shipped) {
    if (file === 'client.js') continue; // described as the settings page, not by name
    const base = path.basename(file);
    assert.ok(readme.includes(base), `README does not mention ${base}`);
  }
}

console.log(`hygiene.test.mjs: all assertions passed (${shipped.length} shipped, ${tests.length} test files)`);
