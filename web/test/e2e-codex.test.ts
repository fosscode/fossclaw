/**
 * E2E tests for Codex provider: full message flow through the server stack.
 *
 * Tests: session creation → browser WS connect → send user_message → receive streaming reply.
 *
 * Uses a real Bun.serve() + WsBridge + CodexBridge wired together.
 * The "Codex app-server" is a mock that auto-pushes streaming notifications
 * in response to turn/start, simulating how the real Codex server behaves.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { CodexBridge } from "../server/codex-bridge.js";
import { WsBridge } from "../server/ws-bridge.js";
import type { SocketData } from "../server/ws-bridge.js";
import { createRoutes } from "../server/routes.js";
import { setAuthCredentials, createSession as createAuthSession } from "../server/auth.js";
import { MockBrowserClient } from "./helpers/mock-browser-client.js";
import type { SdkSessionInfo, LaunchOptions } from "../server/cli-launcher.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ─── Auto-responding mock Codex app-server ────────────────────────────────────
//
// When it receives turn/start it automatically pushes back:
//   turn/started → item/agentMessage/delta → turn/completed
// This simulates the real Codex streaming behaviour.

interface MockCodexServer {
  port: number;
  stop: () => void;
  receivedMethods: string[];
  responseText: string;
}

let _threadSeq = 0;

function createAutoMockCodexServer(): MockCodexServer {
  const receivedMethods: string[] = [];
  const clients = new Set<ServerWebSocket<unknown>>();

  const server: MockCodexServer = {
    port: 0,
    stop: () => {},
    receivedMethods,
    responseText: "Hello from Codex!",
  };

  const push = (method: string, params: Record<string, unknown>) => {
    const raw = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const ws of clients) {
      try { ws.send(raw); } catch { /* disconnected */ }
    }
  };

  const bun = Bun.serve({
    port: 0,
    websocket: {
      open(ws) { clients.add(ws); },
      close(ws) { clients.delete(ws); },
      message(ws, raw) {
        const msg = JSON.parse(raw as string) as {
          jsonrpc: string;
          id: string;
          method: string;
          params?: Record<string, unknown>;
        };
        receivedMethods.push(msg.method);

        let result: unknown;
        switch (msg.method) {
          case "initialize":
            result = { userAgent: "mock-codex/1.0" };
            break;
          case "model/list":
            result = {
              data: [
                { id: "gpt-5.3-codex", model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
              ],
              nextCursor: null,
            };
            break;
          case "thread/start": {
            const threadId = `thread_${++_threadSeq}`;
            result = {
              thread: {
                id: threadId, preview: "", modelProvider: "openai",
                createdAt: 0, updatedAt: 0, path: null,
                cwd: (msg.params?.cwd as string) || "/tmp",
                cliVersion: "1.0", source: "app-server", gitInfo: null, turns: [],
              },
              model: (msg.params?.model as string) || "gpt-5.3-codex",
              cwd: (msg.params?.cwd as string) || "/tmp",
              approvalPolicy: "never",
              sandbox: { type: "workspace-write" },
            };
            break;
          }
          case "turn/start": {
            const threadId = (msg.params?.threadId as string) || "";
            result = {};
            // Push streaming notifications after a small delay (like real Codex)
            const text = server.responseText;
            setTimeout(() => {
              push("turn/started", {
                threadId,
                turn: { id: "auto_turn_1", status: "running", error: null, items: [] },
              });
              push("item/agentMessage/delta", {
                threadId,
                turnId: "auto_turn_1",
                itemId: "item_1",
                delta: text,
              });
              push("turn/completed", {
                threadId,
                turn: { id: "auto_turn_1", status: "completed", error: null, items: [] },
              });
            }, 15);
            break;
          }
          case "turn/interrupt":
            result = {};
            break;
          default:
            result = {};
        }

        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      },
    },
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("Not found", { status: 404 });
    },
  });

  server.port = bun.port;
  server.stop = () => bun.stop(true);
  return server;
}

// ─── Codex-aware mock launcher ────────────────────────────────────────────────
//
// Thin launcher that delegates codex sessions to CodexBridge.
// Mirrors the parts of the real CliLauncher that matter for these tests.

class CodexMockLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private _codexBridge: CodexBridge | null = null;

  setCodexBridge(bridge: CodexBridge) {
    this._codexBridge = bridge;
  }

  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const isCodex = options.provider === "codex" && !!this._codexBridge;

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      provider: isCodex ? "codex" : "claude",
      cwd: options.cwd || "/tmp",
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, info);

    if (isCodex && this._codexBridge) {
      this._codexBridge
        .createSession(sessionId, options.cwd || "/tmp", options.model)
        .then(() => { info.state = "connected"; })
        .catch((e: unknown) => {
          console.error("[CodexMockLauncher] createSession failed:", e);
          info.state = "exited";
        });
    }

    return info;
  }

  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getSession(id: string): SdkSessionInfo | undefined {
    return this.sessions.get(id);
  }

  async kill(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.state = "exited";
    return true;
  }

  removeSession(id: string) {
    this.sessions.delete(id);
  }

  isAlive(id: string): boolean {
    return this.sessions.get(id)?.state !== "exited";
  }
}

// ─── Test server setup ────────────────────────────────────────────────────────

interface CodexTestCtx {
  baseUrl: string;
  wsBaseUrl: string;
  wsBridge: WsBridge;
  codexBridge: CodexBridge;
  mockCodex: MockCodexServer;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  close: () => Promise<void>;
}

async function createCodexTestServer(): Promise<CodexTestCtx> {
  setAuthCredentials("testuser", "testpass");

  const mockCodex = createAutoMockCodexServer();
  const wsBridge = new WsBridge();
  const codexBridge = new CodexBridge(mockCodex.port);
  codexBridge.setWsBridge(wsBridge);

  const launcher = new CodexMockLauncher();
  launcher.setCodexBridge(codexBridge);

  const app = new Hono();
  app.use("/api/*", cors());
  app.route(
    "/api",
    createRoutes(launcher as unknown as Parameters<typeof createRoutes>[0], wsBridge, "/tmp", undefined, codexBridge)
  );

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);

      const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
      if (cliMatch) {
        const upgraded = srv.upgrade(req, { data: { kind: "cli" as const, sessionId: cliMatch[1] } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
      if (browserMatch) {
        const upgraded = srv.upgrade(req, { data: { kind: "browser" as const, sessionId: browserMatch[1] } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req, srv);
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "browser") wsBridge.handleBrowserOpen(ws, ws.data.sessionId);
        // No CLI connections expected for Codex sessions
      },
      message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
        if (ws.data.kind === "browser") wsBridge.handleBrowserMessage(ws, msg);
      },
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.kind === "browser") wsBridge.handleBrowserClose(ws);
      },
    },
  });

  const authSessionId = createAuthSession("testuser");
  const authCookie = `fossclaw_session=${authSessionId}`;
  const authFetch = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", authCookie);
    return fetch(url, { ...init, headers });
  };

  const port = server.port;

  return {
    baseUrl: `http://localhost:${port}`,
    wsBaseUrl: `ws://localhost:${port}`,
    wsBridge,
    codexBridge,
    mockCodex,
    authFetch,
    close: async () => {
      server.stop(true);
      await codexBridge.stop();
      mockCodex.stop();
    },
  };
}

// ─── Helper: create a Codex session via REST and return sessionId ─────────────

async function createCodexSession(
  ctx: CodexTestCtx,
  opts: Record<string, unknown> = {}
): Promise<string> {
  const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "codex", model: "gpt-5.3-codex", cwd: "/tmp", ...opts }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { sessionId: string; provider: string };
  expect(data.provider).toBe("codex");
  return data.sessionId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Codex E2E: message flow", () => {
  let ctx: CodexTestCtx;

  beforeEach(async () => {
    ctx = await createCodexTestServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test("session creation returns provider=codex", async () => {
    const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", model: "gpt-5.3-codex", cwd: "/tmp" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessionId: string; provider: string };
    expect(data.provider).toBe("codex");
    expect(data.sessionId).toBeTruthy();
  });

  test("browser receives session_init for a Codex session", async () => {
    const sessionId = await createCodexSession(ctx);
    // Wait for async createSession → thread/start to complete
    await delay(300);

    const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
    await browser.connect();

    const initMsg = await browser.waitForMessage("session_init");
    expect(initMsg.type).toBe("session_init");

    browser.close();
  });

  test("browser does NOT receive cli_disconnected for a Codex session", async () => {
    const sessionId = await createCodexSession(ctx);
    await delay(300);

    const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
    await browser.connect();

    await browser.waitForMessage("session_init");

    // Give the server a moment to send anything else
    await delay(100);
    const buffered = browser.allMessages();
    const disconnected = buffered.filter((m) => m.type === "cli_disconnected");
    expect(disconnected).toHaveLength(0);

    browser.close();
  });

  test("browser sends user_message and receives streaming text reply", async () => {
    const sessionId = await createCodexSession(ctx);
    await delay(300);

    const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
    await browser.connect();
    await browser.waitForMessage("session_init");

    // Send a user message
    browser.send({ type: "user_message", content: "hello codex" });

    // Should receive status_change: "running" (so the Generating... indicator shows)
    const statusMsg = await browser.waitForMessage("status_change", 3000);
    expect((statusMsg as Record<string, unknown>).status).toBe("running");

    // Should receive message_start stream event
    const msgStart = await browser.waitForMessage("stream_event", 3000);
    expect((msgStart.event as Record<string, unknown>)?.type).toBe("message_start");

    // Then a content_block_delta with the actual text
    const deltaEvent = await browser.waitForMessage("stream_event", 3000);
    const ev = deltaEvent.event as Record<string, unknown>;
    expect(ev?.type).toBe("content_block_delta");
    const delta = ev?.delta as Record<string, unknown>;
    expect(delta?.text).toBe("Hello from Codex!");

    // Then a persistent assistant message (so text doesn't disappear when result clears streaming)
    const assistantMsg = await browser.waitForMessage("assistant", 3000);
    const content = (assistantMsg.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>;
    expect(content?.[0]?.text).toBe("Hello from Codex!");

    // Then the result message (clears streaming state)
    const result = await browser.waitForMessage("result", 3000);
    expect(result.type).toBe("result");

    browser.close();
  });

  test("second message in same session also gets a reply", async () => {
    const sessionId = await createCodexSession(ctx);
    await delay(300);

    const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
    await browser.connect();
    await browser.waitForMessage("session_init");

    // First message
    browser.send({ type: "user_message", content: "first message" });
    await browser.waitForMessage("stream_event", 3000); // message_start
    await browser.waitForMessage("stream_event", 3000); // delta
    await browser.waitForMessage("result", 3000);

    // Second message — must also get a reply
    browser.send({ type: "user_message", content: "second message" });
    await browser.waitForMessage("stream_event", 3000); // message_start
    const delta2 = await browser.waitForMessage("stream_event", 3000); // delta
    const ev2 = delta2.event as Record<string, unknown>;
    expect((ev2?.delta as Record<string, unknown>)?.text).toBe("Hello from Codex!");
    const result2 = await browser.waitForMessage("result", 3000);
    expect(result2.type).toBe("result");

    browser.close();
  });

  test("turn/start is sent to Codex when user sends a message", async () => {
    const sessionId = await createCodexSession(ctx);
    await delay(300);

    const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
    await browser.connect();
    await browser.waitForMessage("session_init");

    const methodsBefore = [...ctx.mockCodex.receivedMethods];
    browser.send({ type: "user_message", content: "hi" });

    // Wait for response to flow back
    await browser.waitForMessage("result", 3000);

    const newMethods = ctx.mockCodex.receivedMethods.slice(methodsBefore.length);
    expect(newMethods).toContain("turn/start");

    browser.close();
  });
});
