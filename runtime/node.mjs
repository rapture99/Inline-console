/**
 * Node entry point for Inline Console.
 *
 * Loaded before the application:
 *   node --import file:///abs/path/to/runtime/node.mjs app.js
 *
 * Transport is a plain TCP socket carrying newline-delimited JSON, so the
 * runtime needs no dependencies and cannot drag a bundler into the app.
 *
 * Everything here is defensive: a logging sidecar must never crash, delay,
 * or keep alive the process it is observing.
 */

import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { markSelf, patchConsole, reportError, createBatcher } from './shared.js';
import { createRecorder } from './recorder.js';

markSelf(import.meta.url);

const PORT = Number(process.env.INLINE_CONSOLE_PORT || 5544);
const HOST = process.env.INLINE_CONSOLE_HOST || '127.0.0.1';
const MAX_BUFFERED = 500;

let socket = null;
let connected = false;
let connecting = false;
let retryTimer = null;
let pending = [];

const sessionId =
  String(process.pid) + '-' + Math.floor(Date.now() % 1e7).toString(36);

function hello() {
  return {
    k: 'hello',
    kind: 'node',
    sessionId,
    pid: process.pid,
    cwd: safe(() => process.cwd()),
    argv: safe(() => process.argv.slice(1)),
    version: process.version,
    ts: Date.now(),
  };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function connect() {
  if (connected || connecting) return;
  connecting = true;

  const s = net.connect({ port: PORT, host: HOST });
  s.setNoDelay(true);

  // A script that logs and exits within a few milliseconds would otherwise
  // die before the connection completes. Hold the loop open until we know
  // the outcome, with a hard guard so an unreachable host cannot hang exit.
  const guard = setTimeout(() => {
    try {
      s.unref();
    } catch {
      /* ignore */
    }
  }, 1000);
  if (typeof guard.unref === 'function') guard.unref();

  s.on('connect', () => {
    clearTimeout(guard);
    s.unref();
    socket = s;
    connected = true;
    connecting = false;
    // A new listener has none of our site tables, so they must be resent
    // before the values that index into them.
    recorder.reset();
    write([hello()]);
    const queued = pending;
    pending = [];
    if (queued.length) write(queued);
  });

  const fail = () => {
    clearTimeout(guard);
    connecting = false;
    connected = false;
    socket = null;
    scheduleRetry();
  };

  s.on('error', fail);
  s.on('close', fail);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, 1000);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

function write(events) {
  if (!connected || !socket) {
    // Keep the newest events; an unbounded buffer would leak.
    pending.push(...events);
    if (pending.length > MAX_BUFFERED) pending = pending.slice(-MAX_BUFFERED);
    connect();
    return;
  }
  try {
    let payload = '';
    for (const event of events) {
      payload += JSON.stringify(withSession(event)) + '\n';
    }
    // Ref across the write so a pending flush keeps the process alive just
    // long enough to deliver it, then release the loop again.
    const s = socket;
    s.ref();
    s.write(payload, () => s.unref());
  } catch {
    /* a failed write is dropped, never thrown */
  }
}

function withSession(event) {
  event.sessionId = sessionId;
  return event;
}

const batcher = createBatcher(write, 50);
const push = batcher.push;

patchConsole({ emit: push });

/* ------------------------------------------------------------------ *
 * Expression capture
 *
 * Opt-in, and scoped: without an explicit root list nothing is rewritten,
 * so an accidental preload can never start transforming a user's code.
 * ------------------------------------------------------------------ */

const recorder = createRecorder({
  emit: push,
  sampleMs: Number(process.env.INLINE_CONSOLE_SAMPLE_MS) || 100,
});

const expressionRoots = (process.env.INLINE_CONSOLE_ROOTS || '')
  .split(path.delimiter)
  .filter(Boolean);

const expressionsEnabled =
  process.env.INLINE_CONSOLE_EXPRESSIONS === '1' && expressionRoots.length > 0;

if (expressionsEnabled) {
  // The recorder must exist before any instrumented module runs; the
  // prologue the transform injects looks it up on first call.
  recorder.install();

  try {
    const { register } = await import('node:module');
    register('./hooks.mjs', import.meta.url, {
      data: {
        roots: expressionRoots,
        runtimeDir: path.dirname(fileURLToPath(import.meta.url)),
      },
    });
  } catch {
    // register() landed in 18.19/20.6. Below that the console path still
    // works and instrumented values simply never appear.
  }
}

// Fires once the loop is empty but before the process actually exits, and
// unlike 'exit' it still permits I/O — this is what lets a script that just
// logs and returns deliver its values.
process.on('beforeExit', () => {
  // Slots first: a short-lived script may never have reached a sampler tick,
  // so its only chance to report is here.
  recorder.flush();
  batcher.flush();
});

process.on('uncaughtException', (err) => {
  reportError(push, err, 'uncaughtException');
  // The values a crash left behind are the ones worth seeing.
  recorder.flush();
  batcher.flush();
  // Preserve default crash behaviour: if nothing else is listening, the app
  // must still die the way it would have without us attached.
  if (process.listenerCount('uncaughtException') === 1) {
    process.removeAllListeners('uncaughtException');
    throw err;
  }
});

process.on('unhandledRejection', (reason) => {
  reportError(push, reason, 'unhandledRejection');
});

connect();
