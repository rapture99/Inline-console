/**
 * Node module customization hooks — the point where the transform meets the
 * application.
 *
 * Registered from node.mjs with `register()`, which runs these hooks on a
 * dedicated loader thread. That isolation is why the transform is pure text
 * to text: nothing here can see the application's `globalThis`, so the code
 * it emits calls a global that node.mjs installs on the *main* thread
 * instead of importing anything from this module.
 *
 * ESM only for now. CommonJS arrives with `Module._compile` patching, which
 * needs the same scope rules but a different attachment point.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from './transform.js';

let roots = [];
let runtimeDir = '';
let maxBytes = 2 * 1024 * 1024;

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/** Windows compares paths case-insensitively; the stored form keeps its case. */
function comparable(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function initialize(data) {
  roots = (data?.roots ?? []).map(comparable);
  runtimeDir = data?.runtimeDir ? comparable(data.runtimeDir) : '';
  if (data?.maxBytes) maxBytes = data.maxBytes;
}

/**
 * Scope is a correctness rule as much as a performance one. Instrumenting a
 * dependency multiplies the cost of the feature while producing values for
 * code the user is not looking at — and instrumenting our own runtime would
 * have the transform rewriting the recorder that the rewrite depends on.
 */
function inScope(filePath) {
  if (!roots.length) return false;

  const target = comparable(filePath);
  if (target.includes(NODE_MODULES)) return false;
  if (runtimeDir && target.startsWith(runtimeDir)) return false;

  return roots.some(
    (root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
  );
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  try {
    if (result.format !== 'module' || result.source == null) return result;
    if (!url.startsWith('file:')) return result;

    let filePath;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return result;
    }
    if (!inScope(filePath)) return result;

    const source =
      typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8');

    if (source.length > maxBytes) return result;

    const instrumented = transform(source, filePath, { sourceType: 'module' });
    if (!instrumented) return result;

    return { ...result, source: instrumented.code };
  } catch {
    // Any failure here must leave the module exactly as Node produced it.
    return result;
  }
}
