/** Wire format shared with runtime/shared.js. Keep the two in sync. */

export type SNode =
  | { t: 'prim'; v: string }
  | { t: 'string'; v: string; trunc?: boolean }
  | { t: 'fn'; name: string; cls?: boolean }
  | { t: 'err'; name: string; message: string; stack?: string }
  | { t: 'arr'; ctor?: string; items: SNode[]; more?: number; len?: number }
  | { t: 'obj'; ctor?: string; entries: [string, SNode][]; more?: number }
  | { t: 'map'; entries: [SNode, SNode][]; more?: number; len?: number }
  | { t: 'set'; items: SNode[]; more?: number; len?: number }
  | { t: 'circ' }
  | { t: 'deep'; ctor?: string };

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface HelloMessage {
  k: 'hello';
  kind: 'node' | 'browser';
  sessionId: string;
  pid?: number;
  cwd?: string;
  argv?: string[];
  version?: string;
  href?: string;
  userAgent?: string;
  ts: number;
}

export interface LogMessage {
  k: 'log';
  sessionId: string;
  level: LogLevel;
  file?: string;
  line?: number;
  col?: number;
  args: SNode[];
  ts: number;
  dropped?: number;
  uncaught?: string;
}

/**
 * A file's instrumentation table, sent once per file per connection.
 *
 * Positions are baked in by the transform, which knows them before it edits
 * anything — so an expression value never needs a source-map round trip the
 * way a console call does. Each tuple is
 * [startLine, startColumn, endLine, endColumn], with 1-based lines and
 * 0-based columns, matching both acorn's output and vscode.Position.
 */
export interface SitesMessage {
  k: 'sites';
  sessionId: string;
  f: number;
  path: string;
  sites: SiteSpan[];
  ts: number;
}

export type SiteSpan = [number, number, number, number];

/** [siteIndex, value, totalHits] — batched per file, one batch per sampler tick. */
export type ValueItem = [number, SNode, number];

export interface ValuesMessage {
  k: 'val';
  sessionId: string;
  f: number;
  items: ValueItem[];
  ts: number;
}

export type RuntimeMessage = HelloMessage | LogMessage | SitesMessage | ValuesMessage;

export interface SessionInfo {
  id: string;
  kind: 'node' | 'browser';
  label: string;
  startedAt: number;
}
