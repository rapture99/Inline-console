/**
 * Copies acorn's ESM build into runtime/vendor/.
 *
 * The transform runs inside the *observed* process, and runtime/node.mjs
 * promises that nothing there carries dependencies. Vendoring keeps that
 * promise: acorn ships as one dependency-free file, so the extension can
 * carry a copy instead of making the user's app resolve a package.
 *
 *   node tools/vendor-acorn.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'acorn', 'dist', 'acorn.mjs');
const pkg = path.join(root, 'node_modules', 'acorn', 'package.json');
const outDir = path.join(root, 'runtime', 'vendor');
const out = path.join(outDir, 'acorn.js');

if (!fs.existsSync(src)) {
  console.error('acorn is not installed — run `npm install --save-dev acorn` first.');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
const code = fs.readFileSync(src, 'utf8');

const header = [
  '/*',
  ` * Vendored from acorn@${version} (dist/acorn.mjs) — MIT.`,
  ' *',
  ' * Do not edit by hand. Re-vendor with:  node tools/vendor-acorn.mjs',
  ' *',
  ' * Vendored rather than imported so the runtime stays dependency-free in the',
  ' * user\'s process. acorn itself has no dependencies, so this is one file.',
  ' */',
  '',
  '',
].join('\n');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, header + code, 'utf8');

const kb = (Buffer.byteLength(header + code) / 1024).toFixed(1);
console.log(`vendored acorn@${version} -> runtime/vendor/acorn.js (${kb} KB)`);
