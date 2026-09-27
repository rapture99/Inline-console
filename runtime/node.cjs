/**
 * CommonJS shim so the runtime also works with `node --require`.
 *
 * Prefer `--import ./node.mjs`: the dynamic import below resolves on a later
 * microtask, so console calls made in the app's very first synchronous tick
 * are missed. For long-running processes (servers, dev tools) that gap is
 * irrelevant.
 */
import('./node.mjs').catch(() => {
  /* never break the host process */
});
