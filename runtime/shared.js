/**
 * Shared runtime for Inline Console.
 *
 * Plain ESM, no dependencies, must run unmodified in Node and in browsers.
 * Responsibilities:
 *   - serialize arbitrary runtime values into a safe, depth-limited tree
 *   - patch console.* and capture the *source position* of each call
 *   - hand finished events to a transport supplied by the host entry point
 */

export const LIMITS = {
  depth: 4,
  arrayItems: 100,
  objectProps: 50,
  stringChars: 2000,
  stackChars: 4000,
};

/* ------------------------------------------------------------------ *
 * Self-identification
 *
 * Stack frames that point back into our own code must be skipped, or
 * every log would be attributed to this file. Entry points register
 * their own location here at load time.
 * ------------------------------------------------------------------ */

const selfMarkers = [];

export function markSelf(location) {
  if (!location) return;
  selfMarkers.push(location);
  // Stacks may show either the file:// URL or the plain path form.
  if (location.startsWith('file://')) {
    try {
      let p = decodeURIComponent(location.slice('file://'.length));
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/x -> C:/x
      selfMarkers.push(p);
      selfMarkers.push(p.replace(/\//g, '\\'));
    } catch {
      /* ignore malformed URLs */
    }
  }
}

// The patched console function lives in *this* file, so its frame is always
// on top of every captured stack. Register before anything else runs.
markSelf(import.meta.url);

function isSelfFrame(file) {
  for (const marker of selfMarkers) {
    if (file.indexOf(marker) !== -1) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

function ctorName(value) {
  try {
    const name = value.constructor && value.constructor.name;
    return name && name !== 'Object' ? name : undefined;
  } catch {
    return undefined;
  }
}

function truncate(str) {
  if (str.length <= LIMITS.stringChars) return { v: str };
  return { v: str.slice(0, LIMITS.stringChars), trunc: true };
}

/**
 * @returns {object} a serializable node describing `value`
 */
export function serialize(value, depth, seen) {
  depth = depth || 0;
  seen = seen || new Set();

  const type = typeof value;

  if (value === null) return { t: 'prim', v: 'null' };
  if (value === undefined) return { t: 'prim', v: 'undefined' };
  if (type === 'boolean' || type === 'number') return { t: 'prim', v: String(value) };
  if (type === 'bigint') return { t: 'prim', v: String(value) + 'n' };
  if (type === 'symbol') return { t: 'prim', v: String(value) };
  if (type === 'string') {
    const s = truncate(value);
    return { t: 'string', v: s.v, trunc: s.trunc };
  }
  if (type === 'function') {
    return { t: 'fn', name: value.name || '(anonymous)', cls: /^class\s/.test(safeSource(value)) };
  }

  // Everything below is an object of some kind.
  if (seen.has(value)) return { t: 'circ' };
  if (depth >= LIMITS.depth) return { t: 'deep', ctor: ctorName(value) };

  seen.add(value);
  try {
    return serializeObject(value, depth, seen);
  } catch (err) {
    return { t: 'prim', v: '<unserializable: ' + safeMessage(err) + '>' };
  } finally {
    seen.delete(value);
  }
}

function safeSource(fn) {
  try {
    return Function.prototype.toString.call(fn).slice(0, 20);
  } catch {
    return '';
  }
}

function safeMessage(err) {
  try {
    return String((err && err.message) || err);
  } catch {
    return 'unknown';
  }
}

function serializeObject(value, depth, seen) {
  if (value instanceof Error) {
    const stack = typeof value.stack === 'string' ? value.stack.slice(0, LIMITS.stackChars) : undefined;
    return { t: 'err', name: value.name || 'Error', message: safeMessage(value), stack };
  }
  if (value instanceof Date) {
    return { t: 'prim', v: isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
  }
  if (value instanceof RegExp) {
    return { t: 'prim', v: String(value) };
  }
  if (typeof Promise !== 'undefined' && value instanceof Promise) {
    return { t: 'prim', v: 'Promise { <pending> }' };
  }

  // DOM nodes: a full property walk is useless and enormous.
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return { t: 'prim', v: describeDomNode(value) };
  }

  if (Array.isArray(value)) {
    const items = [];
    const limit = Math.min(value.length, LIMITS.arrayItems);
    for (let i = 0; i < limit; i++) items.push(serialize(value[i], depth + 1, seen));
    return { t: 'arr', items, more: Math.max(0, value.length - limit), len: value.length };
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const arr = /** @type {any} */ (value);
    const items = [];
    const limit = Math.min(arr.length, LIMITS.arrayItems);
    for (let i = 0; i < limit; i++) items.push({ t: 'prim', v: String(arr[i]) });
    return {
      t: 'arr',
      ctor: ctorName(value),
      items,
      more: Math.max(0, arr.length - limit),
      len: arr.length,
    };
  }

  if (typeof Map !== 'undefined' && value instanceof Map) {
    const entries = [];
    let n = 0;
    for (const [k, v] of value) {
      if (n++ >= LIMITS.objectProps) break;
      entries.push([serialize(k, depth + 1, seen), serialize(v, depth + 1, seen)]);
    }
    return { t: 'map', entries, more: Math.max(0, value.size - entries.length), len: value.size };
  }

  if (typeof Set !== 'undefined' && value instanceof Set) {
    const items = [];
    let n = 0;
    for (const v of value) {
      if (n++ >= LIMITS.objectProps) break;
      items.push(serialize(v, depth + 1, seen));
    }
    return { t: 'set', items, more: Math.max(0, value.size - items.length), len: value.size };
  }

  // Plain-ish object: walk own enumerable keys, tolerating throwing getters.
  const entries = [];
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    keys = [];
  }
  const limit = Math.min(keys.length, LIMITS.objectProps);
  for (let i = 0; i < limit; i++) {
    const key = keys[i];
    let child;
    try {
      child = serialize(value[key], depth + 1, seen);
    } catch (err) {
      child = { t: 'prim', v: '<getter threw: ' + safeMessage(err) + '>' };
    }
    entries.push([key, child]);
  }
  return {
    t: 'obj',
    ctor: ctorName(value),
    entries,
    more: Math.max(0, keys.length - limit),
  };
}

function describeDomNode(node) {
  try {
    if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      const id = node.id ? '#' + node.id : '';
      const cls = node.className && typeof node.className === 'string'
        ? '.' + node.className.trim().split(/\s+/).join('.')
        : '';
      return '<' + tag + id + cls + '>';
    }
    if (node.nodeType === 3) return '#text "' + String(node.nodeValue).slice(0, 40) + '"';
    return '#node(' + node.nodeType + ')';
  } catch {
    return '#node';
  }
}

/* ------------------------------------------------------------------ *
 * Stack parsing
 * ------------------------------------------------------------------ */

/**
 * Split one stack line into { file, line, col }.
 * Handles V8 ("at fn (loc)" / "at loc") and SpiderMonkey/JSC ("fn@loc").
 * The file part may itself contain colons (http://, C:\), so the
 * line/col are peeled off the end rather than split on the first colon.
 */
export function parseFrame(raw) {
  let text = raw.trim();
  if (!text) return undefined;

  if (text.startsWith('at ')) {
    text = text.slice(3).trim();
    const open = text.lastIndexOf('(');
    if (open !== -1 && text.endsWith(')')) {
      text = text.slice(open + 1, -1);
    }
  } else {
    const at = text.lastIndexOf('@');
    if (at !== -1) text = text.slice(at + 1);
  }

  // Strip V8 eval/async wrappers we cannot map anyway.
  if (text.startsWith('async ')) text = text.slice(6);
  if (text.indexOf('eval at ') !== -1) return undefined;

  const m = /^(.*):(\d+):(\d+)$/.exec(text);
  if (!m) return undefined;

  const file = m[1];
  if (!file || file === '<anonymous>' || file.startsWith('node:')) return undefined;

  return { file, line: parseInt(m[2], 10), col: parseInt(m[3], 10) };
}

/**
 * Walk a stack and return the first frame that is not part of this runtime.
 * @param {string} stack
 * @param {number} skip additional user-level frames to skip
 */
export function callSite(stack, skip) {
  if (!stack) return undefined;
  const lines = stack.split('\n');
  let remaining = skip || 0;
  for (let i = 0; i < lines.length; i++) {
    const frame = parseFrame(lines[i]);
    if (!frame) continue;
    if (isSelfFrame(frame.file)) continue;
    if (remaining-- > 0) continue;
    return frame;
  }
  return undefined;
}

function captureStack() {
  const err = new Error();
  if (err.stack) return err.stack;
  try {
    throw err;
  } catch (e) {
    return e.stack || '';
  }
}

/* ------------------------------------------------------------------ *
 * Console patching
 * ------------------------------------------------------------------ */

const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'];

/**
 * @param {object} options
 * @param {(event: object) => void} options.emit  called with each captured event
 * @param {Console} [options.console]             console object to patch
 * @returns {() => void} restore function
 */
export function patchConsole(options) {
  const target = options.console || globalThis.console;
  const emit = options.emit;
  const originals = {};

  // Per-call-site rate limiting. A log inside a render loop or a tight
  // `for` must not be allowed to saturate the socket.
  const rate = new Map();
  const WINDOW_MS = 1000;
  const MAX_PER_WINDOW = 40;

  function allow(key, now) {
    let entry = rate.get(key);
    if (!entry || now - entry.start > WINDOW_MS) {
      entry = { start: now, count: 0, dropped: 0 };
      rate.set(key, entry);
    }
    entry.count++;
    if (entry.count > MAX_PER_WINDOW) {
      entry.dropped++;
      return false;
    }
    return true;
  }

  for (const level of LEVELS) {
    const original = target[level];
    if (typeof original !== 'function') continue;
    originals[level] = original;

    target[level] = function (...args) {
      // The real console output is never suppressed.
      try {
        original.apply(target, args);
      } catch {
        /* a broken console must not break the app */
      }

      try {
        const site = callSite(captureStack(), 0);
        if (!site) return;

        const now = Date.now();
        const key = site.file + ':' + site.line;
        const entry = rate.get(key);
        if (!allow(key, now)) return;

        emit({
          k: 'log',
          level: level === 'trace' || level === 'dir' || level === 'table' ? 'log' : level,
          file: site.file,
          line: site.line,
          col: site.col,
          args: args.map((a) => serialize(a, 0, new Set())),
          ts: now,
          dropped: entry ? entry.dropped : 0,
        });
      } catch {
        /* capture failures are always silent */
      }
    };
  }

  return function restore() {
    for (const level of Object.keys(originals)) target[level] = originals[level];
  };
}

/**
 * Report an uncaught error at its throw site.
 */
export function reportError(emit, error, kind) {
  try {
    const stack = (error && error.stack) || '';
    const site = callSite(stack, 0);
    emit({
      k: 'log',
      level: 'error',
      file: site ? site.file : undefined,
      line: site ? site.line : undefined,
      col: site ? site.col : undefined,
      args: [serialize(error instanceof Error ? error : new Error(String(error)), 0, new Set())],
      ts: Date.now(),
      uncaught: kind || 'uncaught',
    });
  } catch {
    /* ignore */
  }
}

/**
 * Batches events and flushes them on a short timer, so a burst of logs
 * becomes one write instead of hundreds.
 *
 * `flush()` drains immediately — a short-lived process must be able to empty
 * the queue before it exits, or its logs are lost entirely.
 */
export function createBatcher(sink, intervalMs) {
  let queue = [];
  let timer = null;
  const interval = intervalMs || 50;

  function drain() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return false;
    const batch = queue;
    queue = [];
    sink(batch);
    return true;
  }

  function push(event) {
    queue.push(event);
    if (queue.length >= 200) {
      drain();
      return;
    }
    if (timer) return;
    timer = setTimeout(drain, interval);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return { push, flush: drain, get size() { return queue.length; } };
}
