/**
 * Browser entry point for Inline Console.
 *
 * Injected automatically by the Vite plugin, or imported manually:
 *
 *   import { init } from 'inline-console/runtime/browser.js';
 *   init({ url: 'ws://127.0.0.1:5545' });
 *
 * Positions captured here are *generated* positions (the URL the browser
 * actually loaded). The extension resolves them back to original sources
 * by fetching the module's source map — see src/sourcemap.ts.
 */

import { markSelf, patchConsole, reportError, createBatcher } from './shared.js';

markSelf(import.meta.url);

const DEFAULT_URL = 'ws://127.0.0.1:5545';
const MAX_BUFFERED = 500;

let socket = null;
let connected = false;
let pending = [];
let started = false;
let retryDelay = 500;

const sessionId = Math.random().toString(36).slice(2, 10);

export function init(options) {
  if (started) return;

  // Silently no-op outside a browser. Next.js and friends evaluate client
  // modules during server rendering, where WebSocket and addEventListener
  // may be absent — crashing the render would be far worse than not logging.
  if (typeof WebSocket === 'undefined' || typeof globalThis.addEventListener !== 'function') {
    return;
  }

  started = true;

  const url =
    (options && options.url) ||
    globalThis.__INLINE_CONSOLE_WS__ ||
    DEFAULT_URL;

  connect(url);

  const batcher = createBatcher(write, 50);
  const push = batcher.push;
  patchConsole({ emit: push });

  globalThis.addEventListener('error', (event) => {
    reportError(push, event.error || new Error(event.message), 'uncaught');
  });

  globalThis.addEventListener('unhandledrejection', (event) => {
    reportError(push, event.reason, 'unhandledRejection');
  });

  // A page reload should not leave the extension showing a stale session.
  globalThis.addEventListener('beforeunload', () => {
    try {
      batcher.flush();
      if (connected && socket) socket.close();
    } catch {
      /* ignore */
    }
  });
}

function connect(url) {
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleRetry(url);
    return;
  }

  ws.onopen = () => {
    socket = ws;
    connected = true;
    retryDelay = 500;
    write([
      {
        k: 'hello',
        kind: 'browser',
        sessionId,
        href: safeHref(),
        userAgent: safeUA(),
        ts: Date.now(),
      },
    ]);
    const queued = pending;
    pending = [];
    if (queued.length) write(queued);
  };

  ws.onclose = () => {
    connected = false;
    socket = null;
    scheduleRetry(url);
  };

  // onerror is always followed by onclose; retrying here would double up.
  ws.onerror = () => {};
}

function scheduleRetry(url) {
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 10000);
  setTimeout(() => connect(url), delay);
}

function write(events) {
  if (!connected || !socket) {
    pending.push(...events);
    if (pending.length > MAX_BUFFERED) pending = pending.slice(-MAX_BUFFERED);
    return;
  }
  try {
    let payload = '';
    for (const event of events) {
      event.sessionId = sessionId;
      payload += JSON.stringify(event) + '\n';
    }
    socket.send(payload);
  } catch {
    /* dropped, never thrown */
  }
}

function safeHref() {
  try {
    return globalThis.location ? globalThis.location.href : undefined;
  } catch {
    return undefined;
  }
}

function safeUA() {
  try {
    return globalThis.navigator ? globalThis.navigator.userAgent : undefined;
  } catch {
    return undefined;
  }
}
