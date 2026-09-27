/**
 * Side-effect entry for bundlers that cannot easily call init().
 *
 * Next.js (instrumentation-client.ts, or the top of a client component):
 *   import 'inline-console/runtime/browser-auto.js';
 *
 * Set globalThis.__INLINE_CONSOLE_WS__ before this import to override the port.
 */
import { init } from './browser.js';

init();
