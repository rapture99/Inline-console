/**
 * Inspect what the instrumenting transform does to a file.
 *
 *   node tools/transform-preview.mjs examples/node-demo/index.js
 *   node tools/transform-preview.mjs app.js --sites
 *   node tools/transform-preview.mjs app.js --quiet
 *
 * Always re-parses its own output, because a transform that produces
 * unparseable source is the one failure mode that must never ship.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../runtime/vendor/acorn.js';
import { transform } from '../runtime/transform.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const sitesOnly = args.includes('--sites');
const quiet = args.includes('--quiet');

if (!file) {
  console.error('usage: node tools/transform-preview.mjs <file> [--sites] [--quiet]');
  process.exit(2);
}

const abs = path.resolve(file);
const code = fs.readFileSync(abs, 'utf8');
const result = transform(code, abs);

if (!result) {
  console.error(`not instrumented: ${file}`);
  console.error('(parse failure, or no wrappable expressions — the caller uses the original source)');
  process.exit(1);
}

// The self-check. Re-parse under both goal symbols; either one succeeding
// means the output is valid source.
let reparsed = false;
let parseError = '';
for (const sourceType of ['module', 'script']) {
  try {
    parse(result.code, { ecmaVersion: 'latest', sourceType, allowHashBang: true });
    reparsed = true;
    break;
  } catch (err) {
    parseError = err.message;
  }
}

const lineDelta = result.code.split('\n').length - code.split('\n').length;

if (!sitesOnly && !quiet) {
  console.log(result.code);
  console.log('\n' + '─'.repeat(72) + '\n');
}

if (!quiet) {
  const lines = code.split('\n');
  console.log(`sites (${result.sites.length}):`);
  result.sites.forEach((node, index) => {
    const { line, column } = node.loc.start;
    const text = code
      .slice(node.start, node.end)
      .replace(/\s+/g, ' ')
      .slice(0, 54);
    const pad = String(index).padStart(4);
    console.log(`${pad}  ${String(line).padStart(4)}:${String(column).padEnd(3)}  ${node.type.padEnd(22)}  ${text}`);
  });
  if (result.truncated) console.log('\n  … site limit reached; remaining expressions were not instrumented');
  void lines;
  console.log('');
}

console.log(`file        ${path.relative(process.cwd(), abs)}`);
console.log(`recorder    ${result.name}`);
console.log(`sites       ${result.sites.length}`);
console.log(`line delta  ${lineDelta}${lineDelta === 0 ? '  (line numbers preserved)' : '  ** LINES MOVED **'}`);
console.log(`re-parses   ${reparsed ? 'yes' : 'NO — ' + parseError}`);

if (!reparsed || lineDelta !== 0) process.exit(1);
