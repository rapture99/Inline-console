import * as net from 'net';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  RuntimeMessage,
  LogMessage,
  SessionInfo,
  SitesMessage,
  ValuesMessage,
} from './protocol';

export interface ServerHandlers {
  onLog(message: LogMessage): void;
  onSites(message: SitesMessage): void;
  onValues(message: ValuesMessage): void;
  onSessionStart(session: SessionInfo): void;
  onSessionEnd(session: SessionInfo): void;
  onStatus(message: string, isError?: boolean): void;
}

/**
 * Accepts runtime connections on two channels:
 *   - TCP, newline-delimited JSON, for Node processes (dependency-free client)
 *   - WebSocket, same framing, for browsers
 */
export class LogServer {
  private tcp?: net.Server;
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private sessions = new Map<string, SessionInfo>();

  constructor(private handlers: ServerHandlers) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  get activeSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  start(tcpPort: number, wsPort: number): void {
    this.startTcp(tcpPort);
    this.startWs(wsPort);
  }

  private startTcp(port: number): void {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      const owned = new Set<string>();
      const feed = this.createLineReader((message) => this.handle(message, owned));

      socket.on('data', feed);
      socket.on('error', () => this.closeOwned(owned));
      socket.on('close', () => this.closeOwned(owned));
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      this.handlers.onStatus(
        err.code === 'EADDRINUSE'
          ? `TCP port ${port} is already in use — change inlineConsole.tcpPort.`
          : `TCP server error: ${err.message}`,
        true,
      );
    });

    server.listen(port, '127.0.0.1', () => {
      this.handlers.onStatus(`Listening for Node runtimes on tcp://127.0.0.1:${port}`);
    });

    this.tcp = server;
  }

  private startWs(port: number): void {
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('inline-console');
    });

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      this.handlers.onStatus(
        err.code === 'EADDRINUSE'
          ? `WebSocket port ${port} is already in use — change inlineConsole.wsPort.`
          : `WebSocket server error: ${err.message}`,
        true,
      );
    });

    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (socket: WebSocket) => {
      const owned = new Set<string>();
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
  private createLineReader(onMessage: (message: RuntimeMessage) => void) {
    let buffer = '';
    return (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line) as RuntimeMessage);
          } catch {
            /* a malformed frame is skipped, not fatal */
          }
        }
        index = buffer.indexOf('\n');
      }
      // Guard against a peer that never sends a newline.
      if (buffer.length > 8 * 1024 * 1024) buffer = '';
    };
  }

  private handle(message: RuntimeMessage, owned: Set<string>): void {
    if (message.k === 'hello') {
      const session: SessionInfo = {
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

    if (message.sessionId) owned.add(message.sessionId);

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

  private closeOwned(owned: Set<string>): void {
    for (const id of owned) {
      const session = this.sessions.get(id);
      if (!session) continue;
      this.sessions.delete(id);
      this.handlers.onSessionEnd(session);
    }
    owned.clear();
  }

  dispose(): void {
    this.sessions.clear();
    try {
      this.tcp?.close();
    } catch {
      /* ignore */
    }
    try {
      this.wss?.close();
      this.httpServer?.close();
    } catch {
      /* ignore */
    }
    this.tcp = undefined;
    this.wss = undefined;
    this.httpServer = undefined;
  }
}

function describe(message: Extract<RuntimeMessage, { k: 'hello' }>): string {
  if (message.kind === 'browser') {
    try {
      return message.href ? new URL(message.href).host : 'browser';
    } catch {
      return 'browser';
    }
  }
  const script = message.argv?.[0];
  const name = script ? script.split(/[\\/]/).pop() : undefined;
  return name ? `node ${name} (${message.pid})` : `node (${message.pid})`;
}
