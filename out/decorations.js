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
exports.DecorationManager = void 0;
const vscode = __importStar(require("vscode"));
const store_1 = require("./store");
const render_1 = require("./render");
/**
 * Paints the most recent value for each line at the end of that line.
 *
 * One decoration *type* per severity (colours are baked into the type), with
 * the text supplied per range via renderOptions.
 */
class DecorationManager {
    store;
    settings;
    types;
    pending;
    constructor(store, settings) {
        this.store = store;
        this.settings = settings;
        this.types = {
            log: makeType('editorCodeLens.foreground'),
            info: makeType('editorCodeLens.foreground'),
            debug: makeType('editorCodeLens.foreground'),
            warn: makeType('editorWarning.foreground'),
            error: makeType('editorError.foreground'),
        };
    }
    updateSettings(settings) {
        this.settings = settings;
        this.refreshAll();
    }
    /** Redraw only the editors showing one of `changedKeys`. */
    scheduleRefresh(changedKeys) {
        if (this.pending)
            return;
        this.pending = setTimeout(() => {
            this.pending = undefined;
            for (const editor of vscode.window.visibleTextEditors) {
                if (changedKeys && !changedKeys.has((0, store_1.fileKey)(editor.document.uri.fsPath)))
                    continue;
                this.apply(editor);
            }
        }, 40);
    }
    refreshAll() {
        for (const editor of vscode.window.visibleTextEditors)
            this.apply(editor);
    }
    clearAll() {
        for (const editor of vscode.window.visibleTextEditors) {
            for (const type of Object.values(this.types))
                editor.setDecorations(type, []);
        }
    }
    apply(editor) {
        const lines = this.store.linesFor(editor.document.uri.fsPath);
        const buckets = {
            log: [],
            info: [],
            debug: [],
            warn: [],
            error: [],
        };
        if (lines) {
            for (const record of lines.values()) {
                const index = record.line - 1;
                if (index < 0 || index >= editor.document.lineCount)
                    continue;
                const latest = record.values[0];
                if (!latest)
                    continue;
                const text = this.inlineText((0, render_1.previewArgs)(latest.args), record.hits, record.dropped);
                const end = editor.document.lineAt(index).range.end;
                buckets[record.level].push({
                    range: new vscode.Range(end, end),
                    renderOptions: { after: { contentText: text } },
                });
            }
        }
        for (const level of Object.keys(buckets)) {
            editor.setDecorations(this.types[level], buckets[level]);
        }
    }
    inlineText(preview, hits, dropped) {
        let text = preview.replace(/\s*\n\s*/g, ' ').trim();
        const limit = Math.max(20, this.settings.maxInlineLength);
        if (text.length > limit)
            text = text.slice(0, limit - 1) + '…';
        if (this.settings.showHitCount && hits > 1) {
            text += dropped > 0 ? `  ×${hits}+ (throttled)` : `  ×${hits}`;
        }
        return '  ' + text;
    }
    dispose() {
        if (this.pending)
            clearTimeout(this.pending);
        for (const type of Object.values(this.types))
            type.dispose();
    }
}
exports.DecorationManager = DecorationManager;
function makeType(themeColor) {
    return vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor(themeColor),
            fontStyle: 'italic',
            margin: '0 0 0 1.5rem',
        },
        // Values belong to the line, not to whatever the user types next.
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
}
//# sourceMappingURL=decorations.js.map