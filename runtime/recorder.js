/**
 * Value recorder for instrumented expressions.
 *
 * The console path can afford to serialize every call, because a program only
 * logs where someone wrote a log. Instrumented expressions have no such
 * budget: a million-iteration loop over rewritten code produces several
 * million hits, and serializing even a fraction of them would dominate the
 * program we are supposed to be observing.
 *
 * So nothing is serialized on the hot path. Each site owns a slot; a hit
 * overwrites the slot and bumps a counter, and that is all. A sampler walks
 * only the slots that changed, serializes whatever value is current, and
 * emits one batch per file per interval. Cost decouples from iteration count.
 *
 * Two consequences worth knowing:
 *
 *   - Objects are held by reference until the sampler runs, so a value that
 *     mutates in between is reported in its later state. Primitives are
 *     immune, which covers most of what people actually hover.
 *   - A slot drops its reference immediately after serializing, so nothing is
 *     pinned against GC for longer than one interval.
 */

import { serialize } from './shared.js';

/** Serializing thousands of slots in one tick would stall the app. */
const MAX_ITEMS_PER_FLUSH = 400;

/**
 * @param {object} options
 * @param {(event: object) => void} options.emit
 * @param {number} [options.sampleMs]
 */
export function createRecorder(options) {
  const emit = options.emit;
  const sampleMs = Math.max(16, options.sampleMs || 100);

  /** @type {object[]} */
  const files = [];
  const byPath = new Map();
  /** Files with at least one changed slot, awaiting the next flush. */
  let pendingFiles = [];
  let epoch = 0;
  let timer = null;

  /**
   * Called once per module, by the prologue the transform injects. Returns
   * the per-file record function, which the module then holds in a local —
   * so the hot path is a direct call, not a property lookup on a global.
   */
  function file(path, table) {
    let record = byPath.get(path);

    if (!record) {
      const slots = new Array(table.length);
      for (let i = 0; i < table.length; i++) slots[i] = { v: undefined, n: 0, dirty: false };
      record = {
        id: files.length,
        path,
        table,
        slots,
        dirty: [],
        queued: false,
        sentEpoch: -1,
      };
      files.push(record);
      byPath.set(path, record);
    }

    const slots = record.slots;
    const dirty = record.dirty;
    const self = record;

    return function capture(i, v) {
      const slot = slots[i];
      // A stale or mismatched table must degrade to identity, never throw.
      if (slot === undefined) return v;
      slot.v = v;
      slot.n++;
      if (!slot.dirty) {
        slot.dirty = true;
        dirty.push(i);
      }
      if (!self.queued) {
        self.queued = true;
        pendingFiles.push(self);
      }
      return v;
    };
  }

  function flush() {
    if (!pendingFiles.length) return false;

    const batch = pendingFiles;
    pendingFiles = [];
    const ts = Date.now();
    let budget = MAX_ITEMS_PER_FLUSH;

    for (const record of batch) {
      record.queued = false;

      // A reconnect resets the epoch, so the extension always receives a
      // file's site table before any value that refers to it.
      if (record.sentEpoch !== epoch) {
        record.sentEpoch = epoch;
        emit({ k: 'sites', f: record.id, path: record.path, sites: record.table, ts });
      }

      const take = budget > 0 ? Math.min(record.dirty.length, budget) : 0;
      const indices = record.dirty.splice(0, take);
      budget -= take;

      const items = [];
      for (const i of indices) {
        const slot = record.slots[i];
        slot.dirty = false;
        let node;
        try {
          node = serialize(slot.v, 0, new Set());
        } catch {
          node = { t: 'prim', v: '<unserializable>' };
        }
        items.push([i, node, slot.n]);
        // Release the reference the moment it is no longer needed.
        slot.v = undefined;
      }

      if (items.length) emit({ k: 'val', f: record.id, ts, items });

      // Over budget: the rest of this file's slots wait for the next tick.
      if (record.dirty.length && !record.queued) {
        record.queued = true;
        pendingFiles.push(record);
      }
    }

    return true;
  }

  function install() {
    if (globalThis.__inlineConsole__) return false;
    globalThis.__inlineConsole__ = { file, version: 1 };
    // Always-on and unref'd: an idle tick costs a branch, and keeping it off
    // the hot path is worth more than skipping it.
    timer = setInterval(flush, sampleMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  /** After a reconnect the extension has no tables, so they must be resent. */
  function reset() {
    epoch++;
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    if (globalThis.__inlineConsole__ && globalThis.__inlineConsole__.file === file) {
      delete globalThis.__inlineConsole__;
    }
  }

  return { install, flush, reset, dispose, get fileCount() { return files.length; } };
}
