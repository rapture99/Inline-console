import * as path from 'path';
import * as vscode from 'vscode';
import { LogLevel, SNode } from './protocol';

export interface RecordedValue {
  args: SNode[];
  ts: number;
  level: LogLevel;
  sessionId: string;
  uncaught?: string;
}

export interface LineRecord {
  file: string;
  line: number;
  col: number;
  hits: number;
  dropped: number;
  level: LogLevel;
  lastTs: number;
  /** Most recent first, capped at maxHistory. */
  values: RecordedValue[];
}

/** Windows paths compare case-insensitively; the display path keeps its case. */
export function fileKey(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export class LogStore {
  private files = new Map<string, Map<number, LineRecord>>();
  private changed = new Set<string>();
  private emitter = new vscode.EventEmitter<Set<string>>();
  private flushTimer?: NodeJS.Timeout;

  /** Fires with the set of file keys whose records changed. */
  readonly onDidChange = this.emitter.event;

  constructor(private maxHistory: number) {}

  setMaxHistory(value: number): void {
    this.maxHistory = Math.max(1, value);
  }

  record(entry: {
    file: string;
    line: number;
    col: number;
    level: LogLevel;
    args: SNode[];
    ts: number;
    sessionId: string;
    dropped?: number;
    uncaught?: string;
  }): void {
    const key = fileKey(entry.file);
    let lines = this.files.get(key);
    if (!lines) {
      lines = new Map();
      this.files.set(key, lines);
    }

    let record = lines.get(entry.line);
    if (!record) {
      record = {
        file: entry.file,
        line: entry.line,
        col: entry.col,
        hits: 0,
        dropped: 0,
        level: entry.level,
        lastTs: entry.ts,
        values: [],
      };
      lines.set(entry.line, record);
    }

    record.hits++;
    record.dropped += entry.dropped ?? 0;
    record.level = entry.level;
    record.lastTs = entry.ts;
    record.col = entry.col;
    record.values.unshift({
      args: entry.args,
      ts: entry.ts,
      level: entry.level,
      sessionId: entry.sessionId,
      uncaught: entry.uncaught,
    });
    if (record.values.length > this.maxHistory) record.values.length = this.maxHistory;

    this.markChanged(key);
  }

  linesFor(file: string): Map<number, LineRecord> | undefined {
    return this.files.get(fileKey(file));
  }

  recordAt(file: string, line: number): LineRecord | undefined {
    return this.files.get(fileKey(file))?.get(line);
  }

  clear(): void {
    for (const key of this.files.keys()) this.markChanged(key);
    this.files.clear();
  }

  clearSession(sessionId: string): void {
    for (const [key, lines] of this.files) {
      let touched = false;
      for (const [line, record] of lines) {
        const kept = record.values.filter((v) => v.sessionId !== sessionId);
        if (kept.length === record.values.length) continue;
        touched = true;
        if (!kept.length) {
          lines.delete(line);
        } else {
          record.values = kept;
          record.hits = kept.length;
          record.lastTs = kept[0].ts;
          record.level = kept[0].level;
        }
      }
      if (touched) this.markChanged(key);
      if (!lines.size) this.files.delete(key);
    }
  }

  /**
   * Keeps values attached to the right code while the user types. Records on
   * edited lines are dropped (the statement may no longer be the same one);
   * records below the edit shift by the change in line count.
   */
  applyEdit(file: string, startLine: number, endLine: number, delta: number): void {
    const key = fileKey(file);
    const lines = this.files.get(key);
    if (!lines) return;

    const next = new Map<number, LineRecord>();
    let touched = false;

    for (const [line, record] of lines) {
      if (line >= startLine && line <= endLine) {
        touched = true;
        continue; // edited region: the old value no longer describes this code
      }
      if (line > endLine && delta !== 0) {
        touched = true;
        const shifted = line + delta;
        if (shifted < 1) continue;
        record.line = shifted;
        next.set(shifted, record);
        continue;
      }
      next.set(line, record);
    }

    if (!touched) return;
    if (next.size) {
      this.files.set(key, next);
    } else {
      this.files.delete(key);
    }
    this.markChanged(key);
  }

  private markChanged(key: string): void {
    this.changed.add(key);
    if (this.flushTimer) return;
    // Coalesce bursts: a hot loop can produce hundreds of records per frame.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const batch = this.changed;
      this.changed = new Set();
      if (batch.size) this.emitter.fire(batch);
    }, 60);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.emitter.dispose();
  }
}
