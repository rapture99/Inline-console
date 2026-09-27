# Inline Console

Shows `console.log` values and runtime errors **inline in the editor**, on the line that produced them, as your code runs — the Console Ninja idea, built from scratch.

```js
const order = { id: 'a1', total: 99.5 };
console.log('order created', order);   //  order created {id: 'a1', total: 99.5}  ×2
```

Hover the line for the fully expanded value plus the last few calls.

## Running it

```bash
npm install
npm run compile
```

Then press <kbd>F5</kbd> in VS Code ("Run Extension"). A second window opens with the extension loaded.

## Attaching a runtime

### Node — automatic

The extension registers a terminal environment collection, so **any Node process started from the integrated terminal is already instrumented**:

```bash
node examples/node-demo/index.js
```

No flags, no wrapper. It works by appending `--import <runtime>/node.mjs` to `NODE_OPTIONS`. Turn it off with `inlineConsole.autoInjectNodeOptions: false`.

For an external terminal, run **Inline Console: Copy Node Preload Flag** and use it manually:

```bash
node --import file:///.../runtime/node.mjs app.js
```

`--require ./runtime/node.cjs` also works on older Node, but misses logs emitted in the app's first synchronous tick.

### Vite

```js
// vite.config.js
import inlineConsole from '../../vite-plugin/index.js';
export default { plugins: [inlineConsole()] };
```

Dev-only — the runtime is never injected into a production build. Try it:

```bash
cd examples/vite-app && npm install && npm run dev
```

### Next.js, webpack, anything else

Import the runtime from client code (Next 15+: `instrumentation-client.ts`):

```js
import 'inline-console/runtime/browser-auto.js';
```

The Next **server** side is covered by the Node path above.

## How it works

```
your app                      extension host                 editor
────────                      ──────────────                 ──────
console.log(x)
  │
  ├─ original console.log ────────────────────────────────►  terminal (untouched)
  │
  ├─ new Error().stack ──► first non-runtime frame
  ├─ serialize(x)         depth/size-limited, cycle-safe
  └─ batched 50ms ──────► TCP :5544  (node)
                          WS  :5545  (browser)
                              │
                              ├─ source map resolve ──► original file:line
                              ├─ store (per file/line, capped history)
                              └─ decorations + hover ─────►  inline value
```

Four things carry most of the weight:

**Position capture.** `new Error().stack` is parsed and frames belonging to the runtime itself are skipped — `shared.js` registers its own module URL at load, since the patched `console.log` always sits on top of the stack.

**Source maps.** Stacks give *generated* positions. `src/sourcemap.ts` reads the module (from disk, or over HTTP from the dev server), decodes its inline or sibling map, and maps back. Source names are resolved against the module's own URL first, then joined against each workspace root, peeling leading segments until a real file matches. Every failure degrades to the generated position rather than dropping the log.

**Serialization.** You cannot `JSON.stringify` live application values. `runtime/shared.js` walks to a bounded depth with a cycle set, tolerates throwing getters, and special-cases `Error`, `Map`, `Set`, `Date`, typed arrays, promises, and DOM nodes.

**Not perturbing the app.** The original `console` method is always called first. Capture failures are swallowed. The socket is `unref`'d so it never holds the process open — except across a pending write, so short-lived scripts still deliver their values before exiting.

## Settings

| Setting | Default | |
|---|---|---|
| `inlineConsole.enabled` | `true` | Master switch (also the status-bar click target) |
| `inlineConsole.tcpPort` | `5544` | Node channel |
| `inlineConsole.wsPort` | `5545` | Browser channel |
| `inlineConsole.maxInlineLength` | `120` | Inline preview truncation |
| `inlineConsole.showHitCount` | `true` | Append `×N` for repeated calls |
| `inlineConsole.autoInjectNodeOptions` | `true` | Terminal auto-instrumentation |
| `inlineConsole.clearOnSessionStart` | `true` | Drop a session's old values on reconnect |
| `inlineConsole.maxHistoryPerLine` | `20` | Values retained per line for hover |

Commands: **Toggle**, **Clear All Values**, **Show Output Channel**, **Copy Node Preload Flag**.

## Known limits

- Only `console.*` calls are captured — not arbitrary expression values. That would need an AST transform rewriting expressions into instrumented calls; the position plumbing here is what it would build on.
- Values are pinned to lines and shifted as you type, but edits *inside* a logged line drop its value until the code runs again.
- Hot call sites are rate-limited to 40/sec per line at the source; the inline hit count shows `×N+ (throttled)` when that kicks in.
- Both ports bind to `127.0.0.1` only.

## Verified

- Node: call-site accuracy, cycles, throwing getters, `Map`/`Set`/typed arrays, 150-element arrays, `unhandledRejection`, original stdout preserved, no hang when the extension is off (157 ms for a trivial script).
- TypeScript: positions mapped through `tsc` sourcemaps back to `.ts` lines.
- Vite: plugin injection, runtime served from plugin middleware, inline base64 maps decoded over HTTP, WebSocket frames reassembled across split packets.
