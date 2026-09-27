/**
 * Vite plugin for Inline Console.
 *
 *   // vite.config.js
 *   import inlineConsole from 'inline-console/vite-plugin/index.js';
 *   export default { plugins: [inlineConsole()] };
 *
 * Dev-only by design: the runtime is never injected into a production build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
const PREFIX = '/@inline-console/';
const SERVABLE = new Set(['browser.js', 'shared.js']);

/**
 * @param {{ port?: number, host?: string, enabled?: boolean }} [options]
 */
export default function inlineConsole(options = {}) {
  const port = options.port ?? 5545;
  const host = options.host ?? '127.0.0.1';
  const enabled = options.enabled ?? true;

  return {
    name: 'inline-console',
    apply: 'serve',
    enforce: 'pre',

    /**
     * The runtime lives outside the project root, so it cannot be imported
     * through /@fs without widening server.fs.allow — which is both a
     * security smell and unreliable across platforms (the allow-list is
     * normalized to posix paths at config-resolution time). Serving the two
     * files from our own middleware sidesteps the whole question.
     *
     * Registering here, rather than in the returned post hook, installs the
     * middleware ahead of Vite's own transform pipeline.
     */
    configureServer(server) {
      if (!enabled) return;

      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (!url.startsWith(PREFIX)) return next();

        const name = url.slice(PREFIX.length).split('?')[0];
        if (!SERVABLE.has(name)) return next();

        fs.readFile(path.join(runtimeDir, name), 'utf8', (err, code) => {
          if (err) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(code);
        });
      });
    },

    transformIndexHtml() {
      if (!enabled) return [];
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          injectTo: 'head-prepend',
          children: [
            `import { init } from "${PREFIX}browser.js";`,
            `init({ url: "ws://${host}:${port}" });`,
          ].join('\n'),
        },
      ];
    },
  };
}
