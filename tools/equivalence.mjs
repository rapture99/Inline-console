/**
 * Semantic equivalence harness.
 *
 *   node tools/equivalence.mjs
 *   node tools/equivalence.mjs --keep            leave instrumented copies on disk
 *   node tools/equivalence.mjs path/to/file.js   check one file
 *
 * Runs each fixture twice — original, then instrumented — and diffs stdout,
 * stderr, and exit code. The transform's prologue falls back to an identity
 * function when no recorder is installed, so instrumented code runs correctly
 * on its own and any difference in output is a transform bug.
 *
 * This is the gate: a rewrite that changes behaviour is not a degraded
 * feature, it is a broken program, so nothing downstream should be built on a
 * red run here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transform } from '../runtime/transform.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const explicit = args.filter((a) => !a.startsWith('--'));

function corpus() {
  if (explicit.length) return explicit.map((f) => path.resolve(f));
  const dir = path.join(root, 'tests', 'fixtures');
  const fixtures = fs
    .readdirSync(dir)
    .filter((f) => /\.(mjs|cjs|js)$/.test(f))
    .map((f) => path.join(dir, f));
  return [...fixtures, path.join(root, 'examples', 'node-demo', 'index.js')].filter((f) =>
    fs.existsSync(f),
  );
}

function run(file) {
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: path.dirname(file),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status,
  };
}

/** Stack traces name the file, and the two copies have different names. */
function normalize(text, instrumentedName, originalName) {
  return text.split(instrumentedName).join(originalName);
}

function firstDifference(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    if (left[i] !== right[i]) {
      return `  line ${i + 1}\n    original:     ${JSON.stringify(left[i])}\n    instrumented: ${JSON.stringify(right[i])}`;
    }
  }
  return '  (identical line-by-line, differing in trailing whitespace)';
}

let failures = 0;
let checked = 0;
let skipped = 0;

for (const file of corpus()) {
  const rel = path.relative(root, file);
  const code = fs.readFileSync(file, 'utf8');
  const result = transform(code, file);

  if (!result) {
    console.log(`  skip   ${rel}  (not instrumentable)`);
    skipped++;
    continue;
  }

  const ext = path.extname(file);
  const instrumentedPath = file.slice(0, -ext.length) + '.instrumented' + ext;
  fs.writeFileSync(instrumentedPath, result.code, 'utf8');

  let verdict;
  try {
    const before = run(file);
    const after = run(instrumentedPath);

    const originalName = path.basename(file);
    const instrumentedName = path.basename(instrumentedPath);
    const afterOut = normalize(after.stdout, instrumentedName, originalName);
    const afterErr = normalize(after.stderr, instrumentedName, originalName);

    const problems = [];
    if (before.stdout !== afterOut) {
      problems.push('stdout differs\n' + firstDifference(before.stdout, afterOut));
    }
    if (before.stderr !== afterErr) {
      problems.push('stderr differs\n' + firstDifference(before.stderr, afterErr));
    }
    if (before.code !== after.code) {
      problems.push(`  exit code ${before.code} -> ${after.code}`);
    }

    if (problems.length) {
      failures++;
      verdict = `  FAIL   ${rel}  (${result.sites.length} sites)\n` + problems.map((p) => '    ' + p).join('\n');
    } else {
      verdict = `  ok     ${rel}  (${result.sites.length} sites)`;
    }
    checked++;
  } finally {
    if (!keep) fs.rmSync(instrumentedPath, { force: true });
  }

  console.log(verdict);
}

console.log('');
console.log(`${checked} checked, ${failures} failed, ${skipped} skipped`);
if (keep) console.log('instrumented copies left on disk (--keep)');

process.exit(failures ? 1 : 0);
