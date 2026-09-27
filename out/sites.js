"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SiteRegistry = void 0;
const store_1 = require("./store");
/**
 * Instrumentation tables, keyed by session and file id.
 *
 * File ids are assigned by the runtime and are only unique within a session,
 * so two concurrent processes both start at 0. Everything here is therefore
 * scoped by session id, and a session's tables are dropped wholesale when it
 * disconnects — a value arriving after that has nothing to resolve against
 * and is discarded rather than mapped to whatever file now holds that id.
 */
class SiteRegistry {
    bySession = new Map();
    register(sessionId, fileId, path, sites) {
        let files = this.bySession.get(sessionId);
        if (!files) {
            files = new Map();
            this.bySession.set(sessionId, files);
        }
        files.set(fileId, { path, key: (0, store_1.fileKey)(path), sites });
    }
    lookup(sessionId, fileId) {
        return this.bySession.get(sessionId)?.get(fileId);
    }
    /**
     * Resolves one site to its span. Returns undefined when the table is
     * missing or the index is out of range, which happens legitimately: a
     * value batch can be in flight when a session ends.
     */
    span(sessionId, fileId, siteIndex) {
        const file = this.lookup(sessionId, fileId);
        const span = file?.sites[siteIndex];
        if (!file || !span)
            return undefined;
        return {
            path: file.path,
            key: file.key,
            startLine: span[0],
            startColumn: span[1],
            endLine: span[2],
            endColumn: span[3],
        };
    }
    clearSession(sessionId) {
        this.bySession.delete(sessionId);
    }
    clear() {
        this.bySession.clear();
    }
    get sessionCount() {
        return this.bySession.size;
    }
}
exports.SiteRegistry = SiteRegistry;
//# sourceMappingURL=sites.js.map