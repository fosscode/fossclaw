import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { createRoutes } from "../../server/routes.js";
import { WsBridge } from "../../server/ws-bridge.js";
import { setAuthCredentials, createSession } from "../../server/auth.js";
import type { SocketData } from "../../server/ws-bridge.js";
import type { SdkSessionInfo, LaunchOptions } from "../../server/cli-launcher.js";
import type { ServerWebSocket } from "bun";

export interface TestContext {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  baseUrl: string;
  wsBaseUrl: string;
  bridge: WsBridge;
  launcher: MockCliLauncher;
  authCookie: string;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}

/**
 * In-memory mock of CliLauncher — same public interface, no process spawning.
 */
export class MockCliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private defaultCwd: string;

  constructor(defaultCwd = "/tmp") {
    this.defaultCwd = defaultCwd;
  }

  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      provider: "claude",
      cwd: options.cwd || this.defaultCwd,
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, info);
    return info;
  }

  markConnected(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s && s.state === "starting") s.state = "connected";
  }

  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  async kill(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.state = "exited";
    s.exitCode = -1;
    return true;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * Start a test server on an ephemeral port with real WsBridge and mock launcher.
 * Each test should call `close()` in afterEach/afterAll.
 */
export function createTestServer(): TestContext {
  // Set test credentials (auth is now mandatory)
  setAuthCredentials("testuser", "testpass");
  const bridge = new WsBridge();
  const launcher = new MockCliLauncher();
  const app = new Hono();
  app.use("/api/*", cors());
  app.route("/api", createRoutes(launcher as any, bridge, "/tmp"));

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);

      const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
      if (cliMatch) {
        const sessionId = cliMatch[1];
        const upgraded = server.upgrade(req, { data: { kind: "cli" as const, sessionId } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
      if (browserMatch) {
        const sessionId = browserMatch[1];
        const upgraded = server.upgrade(req, { data: { kind: "browser" as const, sessionId } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req, server);
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "cli") {
          bridge.handleCLIOpen(ws, ws.data.sessionId);
          launcher.markConnected(ws.data.sessionId);
        } else if (ws.data.kind === "browser") {
          bridge.handleBrowserOpen(ws, ws.data.sessionId);
        }
      },
      message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
        if (ws.data.kind === "cli") bridge.handleCLIMessage(ws, msg);
        else if (ws.data.kind === "browser") bridge.handleBrowserMessage(ws, msg);
      },
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "cli") bridge.handleCLIClose(ws);
        else if (ws.data.kind === "browser") bridge.handleBrowserClose(ws);
      },
    },
  });

  const port = server.port;

  // Create an auth session for tests
  const sessionId = createSession("testuser");
  const authCookie = `fossclaw_session=${sessionId}`;

  // Helper function for authenticated fetch requests
  const authFetch = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", authCookie);
    return fetch(url, { ...init, headers });
  };

  return {
    server,
    port,
    baseUrl: `http://localhost:${port}`,
    wsBaseUrl: `ws://localhost:${port}`,
    bridge,
    launcher,
    authCookie,
    authFetch,
    close: () => server.stop(true),
  };
}
