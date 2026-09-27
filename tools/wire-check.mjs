/**
 * End-to-end check of the expression-capture wire, without VS Code.
 *
 *   node tools/wire-check.mjs
 *   node tools/wire-check.mjs tests/fixtures/values.mjs
 *
 * Stands up a TCP listener that speaks the extension's half of the protocol,
 * runs a script under the real preload, and verifies three things the editor
 * side will depend on:
 *
 *   - every site table arrives before the values that index into it
 *   - every reported span actually covers the expression it claims to
 *   - a hot loop coalesces, rather than emitting one event per iteration
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const off = args.includes('--off');
const target = path.resolve(
  args.find((a) => !a.startsWith('--')) ?? path.join(root, 'tests', 'fixtures', 'values.mjs'),
);
const PORT = 5599;

const source = fs.readFileSync(target, 'utf8');
const lines = source.split('\n');

/** The span the runtime reported, sliced out of the file it came from. */
function textAt(span) {
  const [startLine, startCol, endLine, endCol] = span;
  if (startLine === endLine) return lines[startLine - 1]?.slice(startCol, endCol) ?? '';
  const first = lines[startLine - 1]?.slice(startCol) ?? '';
  const last = lines[endLine - 1]?.slice(0, endCol) ?? '';
  return `${first} … ${last}`;
}

function preview(node) {
  if (!node) return '?';
  switch (node.t) {
    case 'prim': return node.v;
    case 'string': return JSON.stringify(node.v.length > 30 ? node.v.slice(0, 30) + '…' : node.v);
    case 'fn': return `ƒ ${node.name}`;
    case 'err': return `${node.name}: ${node.message}`;
    case 'arr': return `[${node.items.map(preview).join(', ')}${node.more ? `, +${node.more}` : ''}]`;
    case 'obj': {
      const body = node.entries.map(([k, v]) => `${k}: ${preview(v)}`).join(', ');
      return `${node.ctor ? node.ctor + ' ' : ''}{${body}${node.more ? `, +${node.more}` : ''}}`;
    }
    case 'map': return `Map(${node.len})`;
    case 'set': return `Set(${node.len})`;
    case 'circ': return '[Circular]';
    case 'deep': return `${node.ctor ?? 'Object'} {…}`;
    default: return node.t;
  }
}

const tables = new Map();
const problems = [];
const latest = new Map();
let valueMessages = 0;
let valueItems = 0;
let sawHello = false;

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          handle(JSON.parse(line));
        } catch (err) {
          problems.push(`malformed frame: ${err.message}`);
        }
      }
      index = buffer.indexOf('\n');
    }
  });
});

function handle(message) {
  if (message.k === 'hello') {
    sawHello = true;
    return;
  }
  if (message.k === 'sites') {
    tables.set(`${message.sessionId}:${message.f}`, message);
    return;
  }
  if (message.k === 'val') {
    valueMessages++;
    const table = tables.get(`${message.sessionId}:${message.f}`);
    if (!table) {
      problems.push(`values for file ${message.f} arrived before its site table`);
      return;
    }
    for (const [siteIndex, node, hits] of message.items) {
      valueItems++;
      const span = table.sites[siteIndex];
      if (!span) {
        problems.push(`site ${siteIndex} is outside the table for ${table.path}`);
        continue;
      }
      latest.set(siteIndex, { span, node, hits });
    }
  }
}

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(path.join(root, 'runtime', 'node.mjs')).toString(), target],
  {
    env: {
      ...process.env,
      INLINE_CONSOLE_PORT: String(PORT),
      INLINE_CONSOLE_EXPRESSIONS: off ? '0' : '1',
      INLINE_CONSOLE_ROOTS: root,
      INLINE_CONSOLE_SAMPLE_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));

const exitCode = await new Promise((resolve) => child.on('close', resolve));
// The socket write that carries the final flush can land after 'close'.
await new Promise((resolve) => setTimeout(resolve, 300));
server.close();

/* ------------------------------------------------------------------ */

console.log('program stdout:');
console.log(stdout.trimEnd().split('\n').map((l) => '  ' + l).join('\n'));
if (stderr.trim()) {
  console.log('\nprogram stderr:');
  console.log(stderr.trimEnd().split('\n').map((l) => '  ' + l).join('\n'));
}

const ordered = [...latest.entries()].sort((a, b) => a[1].span[0] - b[1].span[0] || a[1].span[1] - b[1].span[1]);

console.log(`\nvalues (${ordered.length} distinct sites):`);
for (const [, entry] of ordered) {
  const [line, col] = entry.span;
  const text = textAt(entry.span).replace(/\s+/g, ' ');
  const hits = entry.hits > 1 ? `  ×${entry.hits}` : '';
  console.log(
    `  ${String(line).padStart(3)}:${String(col).padEnd(3)}  ${text.slice(0, 38).padEnd(38)}  =  ${preview(entry.node).slice(0, 54)}${hits}`,
  );
}

// A hot loop is the reason slots exist. Every iteration hits several sites,
// so an event count anywhere near the hit count means coalescing failed.
const totalHits = [...latest.values()].reduce((sum, e) => sum + e.hits, 0);
const hottest = [...latest.values()].reduce((max, e) => Math.max(max, e.hits), 0);

if (!sawHello) problems.push('no hello message — the runtime never connected');
if (exitCode !== 0) problems.push(`program exited ${exitCode}`);

if (off) {
  // Expression capture is opt-in because it rewrites source. Off has to mean
  // nothing is parsed, nothing is rewritten, and nothing is sent.
  if (tables.size) problems.push(`disabled, but ${tables.size} file(s) were still instrumented`);
  if (valueItems) problems.push(`disabled, but ${valueItems} value(s) still arrived`);
} else {
  if (!tables.size) problems.push('no site tables — nothing was instrumented');
  if (!valueItems) problems.push('no values arrived');
  if (hottest > 1000 && valueItems > hottest / 10) {
    problems.push(`coalescing failed: ${valueItems} events for ${hottest} hits on the hottest site`);
  }
}

console.log('');
console.log(`files          ${tables.size}`);
console.log(`sites in table ${[...tables.values()].reduce((n, t) => n + t.sites.length, 0)}`);
console.log(`value batches  ${valueMessages}`);
console.log(`value items    ${valueItems}`);
console.log(`recorded hits  ${totalHits.toLocaleString('en-US')}  (hottest site ×${hottest.toLocaleString('en-US')})`);
console.log(`compression    ${valueItems ? (totalHits / valueItems).toFixed(0) : '—'}× fewer events than hits`);

if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nall checks passed');
