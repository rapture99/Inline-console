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
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const url_1 = require("url");
const vscode = __importStar(require("vscode"));
const server_1 = require("./server");
const store_1 = require("./store");
const sourcemap_1 = require("./sourcemap");
const decorations_1 = require("./decorations");
const hover_1 = require("./hover");
const render_1 = require("./render");
const sites_1 = require("./sites");
let output;
let status;
let store;
let resolver;
let decorations;
let sites;
let server;
let config;
/** Resolution is async, so messages are drained through a serial queue. */
const queue = [];
let draining = false;
function activate(context) {
    config = readConfig();
    output = vscode.window.createOutputChannel('Inline Console');
    store = new store_1.LogStore(config.maxHistoryPerLine);
    resolver = new sourcemap_1.SourceMapResolver();
    decorations = new decorations_1.DecorationManager(store, config);
    sites = new sites_1.SiteRegistry();
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'inlineConsole.toggle';
    context.subscriptions.push(output, status, store, decorations);
    updateRoots();
    updateStatus();
    context.subscriptions.push(store.onDidChange((changed) => decorations.scheduleRefresh(changed)), vscode.languages.registerHoverProvider([
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'javascriptreact' },
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'vue' },
        { scheme: 'file', language: 'svelte' },
    ], new hover_1.LogHoverProvider(store)), vscode.window.onDidChangeVisibleTextEditors(() => decorations.refreshAll()), vscode.workspace.onDidChangeWorkspaceFolders(() => {
        updateRoots();
        // The instrumentation scope is the workspace, so it moves with it.
        applyTerminalEnvironment(context);
    }), 
    // Keep values pinned to their statements while the user edits, and drop
    // cached source maps for any file that changed on disk.
    vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme !== 'file' || !event.contentChanges.length)
            return;
        const file = event.document.uri.fsPath;
        for (const change of event.contentChanges) {
            const startLine = change.range.start.line + 1;
            const endLine = change.range.end.line + 1;
            const added = change.text.split('\n').length - 1;
            const removed = endLine - startLine;
            store.applyEdit(file, startLine, endLine, added - removed);
        }
        resolver.invalidate();
    }), vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('inlineConsole'))
            return;
        applyConfig(context);
    }), vscode.commands.registerCommand('inlineConsole.toggle', async () => {
        const target = vscode.workspace.getConfiguration('inlineConsole');
        await target.update('enabled', !config.enabled, vscode.ConfigurationTarget.Global);
    }), vscode.commands.registerCommand('inlineConsole.clear', () => {
        store.clear();
        decorations.clearAll();
        output.appendLine('[inline-console] cleared');
    }), vscode.commands.registerCommand('inlineConsole.showOutput', () => output.show(true)), vscode.commands.registerCommand('inlineConsole.copyNodeCommand', async () => {
        const flag = preloadFlag(context);
        await vscode.env.clipboard.writeText(flag);
        vscode.window.showInformationMessage(`Copied: ${flag}`);
    }));
    applyConfig(context);
}
function deactivate() {
    stopServer();
}
/* ------------------------------------------------------------------ */
function applyConfig(context) {
    const previous = config;
    config = readConfig();
    store.setMaxHistory(config.maxHistoryPerLine);
    decorations.updateSettings(config);
    applyTerminalEnvironment(context);
    const portsChanged = previous.tcpPort !== config.tcpPort || previous.wsPort !== config.wsPort;
    if (!config.enabled) {
        stopServer();
        store.clear();
        decorations.clearAll();
        updateStatus();
        return;
    }
    if (!server || portsChanged) {
        stopServer();
        startServer();
    }
    updateStatus();
}
function readConfig() {
    const section = vscode.workspace.getConfiguration('inlineConsole');
    return {
        enabled: section.get('enabled', true),
        tcpPort: section.get('tcpPort', 5544),
        wsPort: section.get('wsPort', 5545),
        maxInlineLength: section.get('maxInlineLength', 120),
        showHitCount: section.get('showHitCount', true),
        autoInjectNodeOptions: section.get('autoInjectNodeOptions', true),
        clearOnSessionStart: section.get('clearOnSessionStart', true),
        maxHistoryPerLine: section.get('maxHistoryPerLine', 20),
        expressionValues: section.get('expressionValues', false),
        expressionSampleMs: section.get('expressionSampleMs', 100),
    };
}
function startServer() {
    server = new server_1.LogServer({
        onLog: (message) => enqueue(message),
        onSites: (message) => handleSites(message),
        onValues: (message) => handleValues(message),
        onSessionStart: (session) => {
            if (config.clearOnSessionStart) {
                store.clearSession(session.id);
                sites.clearSession(session.id);
                resolver.invalidate();
            }
            output.appendLine(`[inline-console] connected: ${session.label}`);
            updateStatus();
        },
        onSessionEnd: (session) => {
            // File ids are only unique within a session, so a stale table would
            // resolve a later session's values to the wrong file.
            sites.clearSession(session.id);
            output.appendLine(`[inline-console] disconnected: ${session.label}`);
            updateStatus();
        },
        onStatus: (message, isError) => {
            output.appendLine(`[inline-console] ${message}`);
            if (isError)
                vscode.window.showErrorMessage(`Inline Console: ${message}`);
        },
    });
    server.start(config.tcpPort, config.wsPort);
}
function stopServer() {
    server?.dispose();
    server = undefined;
}
function enqueue(message) {
    // A runaway producer must not grow the queue without bound.
    if (queue.length > 5000)
        queue.splice(0, queue.length - 5000);
    queue.push(message);
    if (!draining)
        void drain();
}
async function drain() {
    draining = true;
    try {
        while (queue.length) {
            const message = queue.shift();
            await handleLog(message);
        }
    }
    finally {
        draining = false;
    }
}
async function handleLog(message) {
    if (!config.enabled)
        return;
    if (!message.file || !message.line) {
        // No usable position — still surface it in the output channel.
        output.appendLine(`[${message.level}] ${(0, render_1.previewArgs)(message.args)}`);
        return;
    }
    const position = await resolver.resolve(message.file, message.line, message.col ?? 1);
    if (!position)
        return;
    store.record({
        file: position.file,
        line: position.line,
        col: position.col,
        level: message.level,
        args: message.args,
        ts: message.ts,
        sessionId: message.sessionId,
        dropped: message.dropped,
        uncaught: message.uncaught,
    });
    if (message.uncaught) {
        output.appendLine(`[${message.uncaught}] ${position.file}:${position.line} ${(0, render_1.previewArgs)(message.args)}`);
    }
}
/* ------------------------------------------------------------------ *
 * Expression values
 *
 * Positions arrive pre-resolved in the site table, so unlike the console
 * path these need no source-map lookup and nothing here is async.
 * ------------------------------------------------------------------ */
function handleSites(message) {
    if (!config.enabled || !config.expressionValues)
        return;
    sites.register(message.sessionId, message.f, message.path, message.sites);
    output.appendLine(`[inline-console] instrumented ${message.path} (${message.sites.length} sites)`);
}
function handleValues(message) {
    if (!config.enabled || !config.expressionValues)
        return;
    let unresolved = 0;
    for (const [siteIndex, value, hits] of message.items) {
        const site = sites.span(message.sessionId, message.f, siteIndex);
        if (!site) {
            unresolved++;
            continue;
        }
        // Phase 3 stops here: values are proven to arrive, correctly positioned.
        // Storing and rendering them is the next step.
        const where = `${path.basename(site.path)}:${site.startLine}:${site.startColumn}`;
        const count = hits > 1 ? `  ×${hits}` : '';
        output.appendLine(`[expr] ${where}  ${(0, render_1.previewArgs)([value])}${count}`);
    }
    if (unresolved) {
        output.appendLine(`[inline-console] ${unresolved} value(s) had no site table — session ended mid-flight`);
    }
}
function updateRoots() {
    const roots = (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => folder.uri.fsPath);
    resolver.setRoots(roots);
}
function updateStatus() {
    if (!config.enabled) {
        status.text = '$(circle-slash) Inline Console';
        status.tooltip = 'Inline Console is off — click to enable';
        status.show();
        return;
    }
    const sessions = server?.activeSessions ?? [];
    status.text = sessions.length
        ? `$(debug-console) Inline Console: ${sessions.length}`
        : '$(debug-console) Inline Console';
    status.tooltip = sessions.length
        ? `Connected:\n${sessions.map((s) => `• ${s.label}`).join('\n')}`
        : `Waiting for a runtime on tcp:${config.tcpPort} / ws:${config.wsPort}`;
    status.show();
}
/* ------------------------------------------------------------------ *
 * Terminal auto-injection
 *
 * This is what makes `node app.js` work with no wrapper script: VS Code
 * applies the collection to every integrated terminal it spawns.
 * ------------------------------------------------------------------ */
function preloadFlag(context) {
    const entry = path.join(context.extensionPath, 'runtime', 'node.mjs');
    // A file:// URL sidesteps Windows drive letters and spaces in the path,
    // both of which break a bare --import argument inside NODE_OPTIONS.
    return `--import ${(0, url_1.pathToFileURL)(entry).toString()}`;
}
function applyTerminalEnvironment(context) {
    const collection = context.environmentVariableCollection;
    collection.clear();
    if (!config.enabled || !config.autoInjectNodeOptions)
        return;
    collection.description = 'Inline Console: preloads the value-capturing runtime into Node.';
    collection.append('NODE_OPTIONS', ` ${preloadFlag(context)}`);
    collection.replace('INLINE_CONSOLE_PORT', String(config.tcpPort));
    // Expression capture rewrites source, so it stays opt-in and is confined to
    // the workspace: with no roots the runtime instruments nothing at all.
    if (!config.expressionValues)
        return;
    const roots = (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => folder.uri.fsPath);
    if (!roots.length)
        return;
    collection.replace('INLINE_CONSOLE_EXPRESSIONS', '1');
    collection.replace('INLINE_CONSOLE_ROOTS', roots.join(path.delimiter));
    collection.replace('INLINE_CONSOLE_SAMPLE_MS', String(config.expressionSampleMs));
}
//# sourceMappingURL=extension.js.map