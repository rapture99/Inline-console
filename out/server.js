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
exports.LogServer = void 0;
const net = __importStar(require("net"));
const http = __importStar(require("http"));
const ws_1 = require("ws");
/**
 * Accepts runtime connections on two channels:
 *   - TCP, newline-delimited JSON, for Node processes (dependency-free client)
 *   - WebSocket, same framing, for browsers
 */
class LogServer {
    handlers;
    tcp;
    httpServer;
    wss;
    sessions = new Map();
    constructor(handlers) {
        this.handlers = handlers;
    }
    get sessionCount() {
        return this.sessions.size;
    }
    get activeSessions() {
        return [...this.sessions.values()];
    }
    start(tcpPort, wsPort) {
        this.startTcp(tcpPort);
        this.startWs(wsPort);
    }
    startTcp(port) {
        const server = net.createServer((socket) => {
            socket.setEncoding('utf8');
            const owned = new Set();
            const feed = this.createLineReader((message) => this.handle(message, owned));
            socket.on('data', feed);
            socket.on('error', () => this.closeOwned(owned));
            socket.on('close', () => this.closeOwned(owned));
        });
        server.on('error', (err) => {
            this.handlers.onStatus(err.code === 'EADDRINUSE'
                ? `TCP port ${port} is already in use — change inlineConsole.tcpPort.`
                : `TCP server error: ${err.message}`, true);
        });
        server.listen(port, '127.0.0.1', () => {
            this.handlers.onStatus(`Listening for Node runtimes on tcp://127.0.0.1:${port}`);
        });
        this.tcp = server;
    }
    startWs(port) {
        const httpServer = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('inline-console');
        });
        httpServer.on('error', (err) => {
            this.handlers.onStatus(err.code === 'EADDRINUSE'
                ? `WebSocket port ${port} is already in use — change inlineConsole.wsPort.`
                : `WebSocket server error: ${err.message}`, true);
        });
        const wss = new ws_1.WebSocketServer({ server: httpServer });
        wss.on('connection', (socket) => {
            const owned = new Set();
            const feed = this.createLineReader((message) => this.handle(message, owned));
            socket.on('message', (data) => feed(data.toString()));
            socket.on('error', () => this.closeOwned(owned));
            socket.on('close', () => this.closeOwned(owned));
        });
        httpServer.listen(port, '127.0.0.1', () => {
            this.handlers.onStatus(`Listening for browser runtimes on ws://127.0.0.1:${port}`);
        });
        this.httpServer = httpServer;
        this.wss = wss;
    }
    /**
     * Both transports carry newline-delimited JSON, and neither guarantees that
     * a chunk ends on a message boundary — so both need the same reassembly.
     */
    createLineReader(onMessage) {
        let buffer = '';
        return (chunk) => {
            buffer += chunk;
            let index = buffer.indexOf('\n');
            while (index !== -1) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (line) {
                    try {
                        onMessage(JSON.parse(line));
                    }
                    catch {
                        /* a malformed frame is skipped, not fatal */
                    }
                }
                index = buffer.indexOf('\n');
            }
            // Guard against a peer that never sends a newline.
            if (buffer.length > 8 * 1024 * 1024)
                buffer = '';
        };
    }
    handle(message, owned) {
        if (message.k === 'hello') {
            const session = {
                id: message.sessionId,
                kind: message.kind,
                label: describe(message),
                startedAt: message.ts,
            };
            this.sessions.set(session.id, session);
            owned.add(session.id);
            this.handlers.onSessionStart(session);
            return;
        }
        if (message.sessionId)
            owned.add(message.sessionId);
        if (message.k === 'log') {
            this.handlers.onLog(message);
            return;
        }
        // Site tables always precede the values that index into them, because the
        // runtime emits both through one ordered batcher.
        if (message.k === 'sites') {
            this.handlers.onSites(message);
            return;
        }
        if (message.k === 'val') {
            this.handlers.onValues(message);
        }
    }
    closeOwned(owned) {
        for (const id of owned) {
            const session = this.sessions.get(id);
            if (!session)
                continue;
            this.sessions.delete(id);
            this.handlers.onSessionEnd(session);
        }
        owned.clear();
    }
    dispose() {
        this.sessions.clear();
        try {
            this.tcp?.close();
        }
        catch {
            /* ignore */
        }
        try {
            this.wss?.close();
            this.httpServer?.close();
        }
        catch {
            /* ignore */
        }
        this.tcp = undefined;
        this.wss = undefined;
        this.httpServer = undefined;
    }
}
exports.LogServer = LogServer;
function describe(message) {
    if (message.kind === 'browser') {
        try {
            return message.href ? new URL(message.href).host : 'browser';
        }
        catch {
            return 'browser';
        }
    }
    const script = message.argv?.[0];
    const name = script ? script.split(/[\\/]/).pop() : undefined;
    return name ? `node ${name} (${message.pid})` : `node (${message.pid})`;
}
//# sourceMappingURL=server.js.map