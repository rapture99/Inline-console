import { SiteSpan } from './protocol';
import { fileKey } from './store';

/**
 * Instrumentation tables, keyed by session and file id.
 *
 * File ids are assigned by the runtime and are only unique within a session,
 * so two concurrent processes both start at 0. Everything here is therefore
 * scoped by session id, and a session's tables are dropped wholesale when it
 * disconnects — a value arriving after that has nothing to resolve against
 * and is discarded rather than mapped to whatever file now holds that id.
 */
export class SiteRegistry {
  private bySession = new Map<string, Map<number, RegisteredFile>>();

  register(sessionId: string, fileId: number, path: string, sites: SiteSpan[]): void {
    let files = this.bySession.get(sessionId);
    if (!files) {
      files = new Map();
      this.bySession.set(sessionId, files);
    }
    files.set(fileId, { path, key: fileKey(path), sites });
  }

  lookup(sessionId: string, fileId: number): RegisteredFile | undefined {
    return this.bySession.get(sessionId)?.get(fileId);
  }

  /**
   * Resolves one site to its span. Returns undefined when the table is
   * missing or the index is out of range, which happens legitimately: a
   * value batch can be in flight when a session ends.
   */
  span(sessionId: string, fileId: number, siteIndex: number): ResolvedSite | undefined {
    const file = this.lookup(sessionId, fileId);
    const span = file?.sites[siteIndex];
    if (!file || !span) return undefined;
    return {
      path: file.path,
      key: file.key,
      startLine: span[0],
      startColumn: span[1],
      endLine: span[2],
      endColumn: span[3],
    };
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  clear(): void {
    this.bySession.clear();
  }

  get sessionCount(): number {
    return this.bySession.size;
  }
}

export interface RegisteredFile {
  path: string;
  key: string;
  sites: SiteSpan[];
}

export interface ResolvedSite {
  path: string;
  key: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
