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
exports.LogHoverProvider = void 0;
const vscode = __importStar(require("vscode"));
const render_1 = require("./render");
/**
 * Full, expanded view of the values recorded for the hovered line, plus a
 * short history so you can see how a value changed across calls.
 */
class LogHoverProvider {
    store;
    constructor(store) {
        this.store = store;
    }
    provideHover(document, position) {
        const record = this.store.recordAt(document.uri.fsPath, position.line + 1);
        if (!record || !record.values.length)
            return undefined;
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = false;
        markdown.supportThemeIcons = true;
        markdown.appendMarkdown(header(record) + '\n\n');
        markdown.appendCodeblock((0, render_1.expandArgs)(record.values[0].args), 'javascript');
        const history = record.values.slice(1, 6);
        if (history.length) {
            markdown.appendMarkdown(`\n**Previous ${history.length}**\n\n`);
            for (const value of history) {
                markdown.appendMarkdown(`- \`${escapeInline((0, render_1.previewArgs)(value.args))}\`\n`);
            }
        }
        if (record.dropped > 0) {
            markdown.appendMarkdown(`\n_${record.dropped} call${record.dropped === 1 ? '' : 's'} throttled at the source._\n`);
        }
        return new vscode.Hover(markdown, document.lineAt(position.line).range);
    }
}
exports.LogHoverProvider = LogHoverProvider;
function header(record) {
    const latest = record.values[0];
    const kind = latest.uncaught ? `$(error) ${latest.uncaught}` : `console.${latest.level}`;
    const hits = record.hits > 1 ? ` · ${record.hits} calls` : '';
    return `**${kind}**${hits} · ${ago(record.lastTs)}`;
}
function ago(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 2)
        return 'just now';
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}
function escapeInline(text) {
    return text.replace(/\s*\n\s*/g, ' ').replace(/`/g, 'ˋ');
}
//# sourceMappingURL=hover.js.map