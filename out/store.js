"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogStore = void 0;
exports.fileKey = fileKey;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
/** Windows paths compare case-insensitively; the display path keeps its case. */
function fileKey(file) {
    const normalized = path.normalize(file);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
class LogStore {
    maxHistory;
    files = new Map();
    changed = new Set();
    emitter = new vscode.EventEmitter();
    flushTimer;
    /** Fires with the set of file keys whose records changed. */
    onDidChange = this.emitter.event;
    constructor(maxHistory) {
        this.maxHistory = maxHistory;
    }
    setMaxHistory(value) {
        this.maxHistory = Math.max(1, value);
    }
    record(entry) {
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
        if (record.values.length > this.maxHistory)
            record.values.length = this.maxHistory;
        this.markChanged(key);
    }
    linesFor(file) {
        return this.files.get(fileKey(file));
    }
    recordAt(file, line) {
        return this.files.get(fileKey(file))?.get(line);
    }
    clear() {
        for (const key of this.files.keys())
            this.markChanged(key);
        this.files.clear();
    }
    clearSession(sessionId) {
        for (const [key, lines] of this.files) {
            let touched = false;
            for (const [line, record] of lines) {
                const kept = record.values.filter((v) => v.sessionId !== sessionId);
                if (kept.length === record.values.length)
                    continue;
                touched = true;
                if (!kept.length) {
                    lines.delete(line);
                }
                else {
                    record.values = kept;
                    record.hits = kept.length;
                    record.lastTs = kept[0].ts;
                    record.level = kept[0].level;
                }
            }
            if (touched)
                this.markChanged(key);
            if (!lines.size)
                this.files.delete(key);
        }
    }
    /**
     * Keeps values attached to the right code while the user types. Records on
     * edited lines are dropped (the statement may no longer be the same one);
     * records below the edit shift by the change in line count.
     */
    applyEdit(file, startLine, endLine, delta) {
        const key = fileKey(file);
        const lines = this.files.get(key);
        if (!lines)
            return;
        const next = new Map();
        let touched = false;
        for (const [line, record] of lines) {
            if (line >= startLine && line <= endLine) {
                touched = true;
                continue; // edited region: the old value no longer describes this code
            }
            if (line > endLine && delta !== 0) {
                touched = true;
                const shifted = line + delta;
                if (shifted < 1)
                    continue;
                record.line = shifted;
                next.set(shifted, record);
                continue;
            }
            next.set(line, record);
        }
        if (!touched)
            return;
        if (next.size) {
            this.files.set(key, next);
        }
        else {
            this.files.delete(key);
        }
        this.markChanged(key);
    }
    markChanged(key) {
        this.changed.add(key);
        if (this.flushTimer)
            return;
        // Coalesce bursts: a hot loop can produce hundreds of records per frame.
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            const batch = this.changed;
            this.changed = new Set();
            if (batch.size)
                this.emitter.fire(batch);
        }, 60);
    }
    dispose() {
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.emitter.dispose();
    }
}
exports.LogStore = LogStore;
//# sourceMappingURL=store.js.map