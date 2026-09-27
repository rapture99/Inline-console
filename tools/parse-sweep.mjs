/**
 * Transforms a large corpus of real code and checks two invariants on every
 * file: the output re-parses, and no line moved.
 *
 *   node tools/parse-sweep.mjs                 sweep node_modules + out + runtime
 *   node tools/parse-sweep.mjs some/dir        sweep one tree
 *   node tools/parse-sweep.mjs --verbose       list every failure's message
 *
 * Execution equivalence (tools/equivalence.mjs) proves behaviour on a handful
 * of files we wrote. This proves *syntax* against thousands we did not, which
 * is where unfamiliar constructs actually live.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../runtime/vendor/acorn.js';
import { transform } from '../runtime/transform.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const targets = args.filter((a) => !a.startsWith('--'));

const roots = targets.length
  ? targets.map((t) => path.resolve(t))
  : [
      path.join(root, 'node_modules'),
      path.join(root, 'out'),
      path.join(root, 'runtime'),
      path.join(root, 'vite-plugin'),
    ].filter((d) => fs.existsSync(d));

const MAX_BYTES = 2 * 1024 * 1024;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(m?js|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

// Must stay as lenient as the transform's own parse, or files it accepts
// (top-level return, await outside a function) get reported as breakage.
const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
};

/** @returns {string | null} an error message, or null when the code parses. */
function parseError(code) {
  let last = null;
  for (const sourceType of ['module', 'script']) {
    try {
      parse(code, { ...PARSE_OPTIONS, sourceType });
      return null;
    } catch (err) {
      last = err.message;
    }
  }
  return last;
}

let total = 0;
let instrumented = 0;
let skipped = 0;
let sites = 0;
const broken = [];
const moved = [];
const started = Date.now();

for (const dir of roots) {
  for (const file of walk(dir)) {
    let code;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) continue;
      code = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    total++;

    // Only files that already parse can tell us anything: if the original is
    // unparseable, the transform declining it is correct behaviour.
    if (parseError(code)) {
      skipped++;
      continue;
    }

    const result = transform(code, file);
    if (!result) {
      skipped++;
      continue;
    }

    instrumented++;
    sites += result.sites.length;

    const error = parseError(result.code);
    if (error) broken.push({ file, error });

    if (result.code.split('\n').length !== code.split('\n').length) {
      moved.push({ file });
    }
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

for (const entry of broken.slice(0, verbose ? broken.length : 10)) {
  console.log(`  BROKEN  ${path.relative(root, entry.file)}`);
  if (verbose) console.log(`          ${entry.error}`);
}
for (const entry of moved.slice(0, 10)) {
  console.log(`  MOVED   ${path.relative(root, entry.file)}`);
}
if (!verbose && broken.length > 10) console.log(`  … and ${broken.length - 10} more (--verbose)`);

console.log('');
console.log(`scanned        ${total} files in ${elapsed}s`);
console.log(`instrumented   ${instrumented}`);
console.log(`skipped        ${skipped}  (unparseable as-is, or nothing to wrap)`);
console.log(`sites          ${sites.toLocaleString('en-US')}`);
console.log(`re-parse fail  ${broken.length}`);
console.log(`lines moved    ${moved.length}`);

process.exit(broken.length || moved.length ? 1 : 0);
