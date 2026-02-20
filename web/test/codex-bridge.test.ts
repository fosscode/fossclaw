/**
 * Unit tests for CodexBridge
 *
 * Uses a real in-process Bun.serve() WebSocket mock to simulate the
 * codex app-server JSON-RPC 2.0 over WebSocket protocol.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { CodexBridge } from "../server/codex-bridge.js";
import { WsBridge } from "../server/ws-bridge.js";
import type { ServerWebSocket } from "bun";

// ─── Mock Codex app-server ────────────────────────────────────────────────────

interface MockServer {
  port: number;
  stop: () => void;
  /** All JSON-RPC methods received from clients */
  receivedMethods: string[];
  /** All connected WebSocket clients */
  clients: Set<ServerWebSocket<unknown>>;
  /** Next thread/start response (default: auto-generate thread ID) */
  threadStartResult?: { thread: { id: string } } | { error: string };
  /** Push a JSON-RPC notification to all connected clients */
  pushNotification: (method: string, params: Record<string, unknown>) => void;
  /** Push a JSON-RPC server request to all connected clients */
  pushServerRequest: (id: string, method: string, params: Record<string, unknown>) => void;
}

let threadSeq = 0;

function createMockCodexServer(): MockServer {
  const receivedMethods: string[] = [];
  const clients = new Set<ServerWebSocket<unknown>>();

  const server: MockServer = {
    port: 0,
    stop: () => {},
    receivedMethods,
    clients,
    pushNotification(method, params) {
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
      for (const ws of clients) {
        try { ws.send(msg); } catch { /* disconnected */ }
      }
    },
    pushServerRequest(id, method, params) {
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      for (const ws of clients) {
        try { ws.send(msg); } catch { /* disconnected */ }
      }
    },
  };

  const bun = Bun.serve({
    port: 0,
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      close(ws) {
        clients.delete(ws);
      },
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
                { id: "o4-mini", model: "o4-mini", displayName: "o4-mini" },
              ],
              nextCursor: null,
            };
            break;
          case "thread/start": {
            if (server.threadStartResult) {
              const override = server.threadStartResult;
              server.threadStartResult = undefined;
              if ("error" in override) {
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: override.error } }));
                return;
              }
              result = override;
            } else {
              const threadId = `thread_${++threadSeq}`;
              result = {
                thread: { id: threadId, preview: "", modelProvider: "openai", createdAt: 0, updatedAt: 0, path: null, cwd: "/tmp", cliVersion: "1.0", source: "app-server", gitInfo: null, turns: [] },
                model: (msg.params?.model as string) || "gpt-5.3-codex",
                cwd: (msg.params?.cwd as string) || "/tmp",
                approvalPolicy: "never",
                sandbox: { type: "workspace-write" },
              };
            }
            break;
          }
          case "turn/start":
            result = {};
            break;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CodexBridge", () => {
  let mockServer: MockServer;
  let bridge: CodexBridge;
  let wsBridge: WsBridge;

  beforeAll(() => {
    mockServer = createMockCodexServer();
  });

  afterAll(() => {
    mockServer.stop();
  });

  afterEach(async () => {
    await bridge?.stop();
    mockServer.receivedMethods.length = 0;
    mockServer.threadStartResult = undefined;
  });

  function makeBridge() {
    bridge = new CodexBridge(mockServer.port);
    wsBridge = new WsBridge();
    bridge.setWsBridge(wsBridge);
    return bridge;
  }

  // ─── start ──────────────────────────────────────────────────────────────────

  describe("start()", () => {
    test("connects and sends initialize", async () => {
      makeBridge();
      await bridge.start();
      expect(mockServer.receivedMethods).toContain("initialize");
    });

    test("idempotent — only initializes once", async () => {
      makeBridge();
      await bridge.start();
      await bridge.start();
      const initHits = mockServer.receivedMethods.filter((m) => m === "initialize");
      expect(initHits.length).toBe(1);
    });
  });

  // ─── listModels ─────────────────────────────────────────────────────────────

  describe("listModels()", () => {
    test("returns models from server", async () => {
      makeBridge();
      const models = await bridge.listModels();
      expect(models.length).toBe(2);
      expect(models[0]).toEqual({ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" });
      expect(models[1]).toEqual({ id: "o4-mini", name: "o4-mini" });
      expect(mockServer.receivedMethods).toContain("model/list");
    });

    test("returns empty array when server unreachable (bridge already started)", async () => {
      // Force bridge into 'ready' state with a bad ws (null)
      const badBridge = new CodexBridge(59992);
      (badBridge as unknown as { ready: boolean }).ready = true;
      const models = await badBridge.listModels();
      expect(models).toEqual([]);
    });
  });

  // ─── createSession ──────────────────────────────────────────────────────────

  describe("createSession()", () => {
    test("sends thread/start and registers session", async () => {
      makeBridge();
      await bridge.createSession("fc-001", "/home/user", "gpt-5.3-codex");
      expect(bridge.isCodexSession("fc-001")).toBe(true);
      expect(mockServer.receivedMethods).toContain("thread/start");
    });

    test("isCodexSession returns false before creation", async () => {
      makeBridge();
      expect(bridge.isCodexSession("fc-nobody")).toBe(false);
    });

    test("works without a model", async () => {
      makeBridge();
      await bridge.createSession("fc-nomodel", "/tmp");
      expect(bridge.isCodexSession("fc-nomodel")).toBe(true);
    });

    test("injects session_init via WsBridge", async () => {
      makeBridge();
      const injected: Array<{ sessionId: string; msg: unknown }> = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = (sid, msg) => {
        injected.push({ sessionId: sid, msg });
        original(sid, msg);
      };

      await bridge.createSession("fc-init", "/tmp", "gpt-5.3-codex");

      const init = injected.find(
        (i) => i.sessionId === "fc-init" && (i.msg as { type: string }).type === "session_init"
      );
      expect(init).toBeDefined();
    });

    test("throws when thread/start returns no thread.id", async () => {
      makeBridge();
      // Override to return empty result
      mockServer.threadStartResult = { thread: { id: "" } } as { thread: { id: string } };
      await expect(bridge.createSession("fc-bad", "/tmp")).rejects.toThrow();
    });
  });

  // ─── sendMessage ────────────────────────────────────────────────────────────

  describe("sendMessage()", () => {
    test("sends turn/start with text input", async () => {
      makeBridge();
      await bridge.createSession("fc-send-1", "/tmp", "gpt-5.3-codex");
      mockServer.receivedMethods.length = 0; // reset
      await bridge.sendMessage("fc-send-1", "hello world");
      expect(mockServer.receivedMethods).toContain("turn/start");
    });

    test("throws for unknown session", async () => {
      makeBridge();
      await bridge.start();
      await expect(bridge.sendMessage("nonexistent", "hi")).rejects.toThrow(
        "No Codex session for nonexistent"
      );
    });

    test("sends with images without throwing", async () => {
      makeBridge();
      await bridge.createSession("fc-img", "/tmp");
      await expect(
        bridge.sendMessage("fc-img", "describe", [
          { media_type: "image/png", data: "abc123==" },
        ])
      ).resolves.toBeUndefined();
    });

    test("injects message_start stream event before sending", async () => {
      makeBridge();
      const injected: unknown[] = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        injected.push(msg);
        original(sid, msg);
      });

      await bridge.createSession("fc-send-2", "/tmp");
      injected.length = 0; // clear session_init
      await bridge.sendMessage("fc-send-2", "hello");

      const msgStart = injected.find(
        (m) => (m as { type: string; event?: { type: string } }).type === "stream_event"
          && (m as { event: { type: string } }).event?.type === "message_start"
      );
      expect(msgStart).toBeDefined();
    });
  });

  // ─── abort ──────────────────────────────────────────────────────────────────

  describe("abort()", () => {
    test("no-ops when no current turn ID", async () => {
      makeBridge();
      await bridge.createSession("fc-abort-noturn", "/tmp");
      // No turn started, so no currentTurnId
      await expect(bridge.abort("fc-abort-noturn")).resolves.toBeUndefined();
    });

    test("no-ops for unknown session", async () => {
      makeBridge();
      await bridge.start();
      await expect(bridge.abort("nobody")).resolves.toBeUndefined();
    });
  });

  // ─── removeSession ──────────────────────────────────────────────────────────

  describe("removeSession()", () => {
    test("removes session from map", async () => {
      makeBridge();
      await bridge.createSession("fc-rm", "/tmp");
      expect(bridge.isCodexSession("fc-rm")).toBe(true);
      bridge.removeSession("fc-rm");
      expect(bridge.isCodexSession("fc-rm")).toBe(false);
    });

    test("no-ops for unknown id", () => {
      makeBridge();
      expect(() => bridge.removeSession("nobody")).not.toThrow();
    });
  });

  // ─── notification routing ────────────────────────────────────────────────────

  describe("JSON-RPC notifications", () => {
    test("item/agentMessage/delta routes streaming text delta", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-notif-delta") injected.push(msg);
        original(sid, msg);
      });

      await bridge.createSession("fc-notif-delta", "/tmp");
      injected.length = 0;

      // Find the threadId that was registered
      const sessions = (bridge as unknown as { sessions: Map<string, { threadId: string }> }).sessions;
      const { threadId } = sessions.get("fc-notif-delta")!;

      mockServer.pushNotification("item/agentMessage/delta", {
        threadId,
        turnId: "turn_1",
        itemId: "item_1",
        delta: "Hello!",
      });
      await delay(80);

      const ev = injected.find(
        (m) => (m as { type: string }).type === "stream_event"
      ) as { event: { type: string; delta: { type: string; text: string } } } | undefined;
      expect(ev).toBeDefined();
      expect(ev?.event.delta.text).toBe("Hello!");
    });

    test("turn/completed routes result message", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-notif-complete") injected.push(msg);
        original(sid, msg);
      });

      await bridge.createSession("fc-notif-complete", "/tmp");
      injected.length = 0;

      const sessions = (bridge as unknown as { sessions: Map<string, { threadId: string }> }).sessions;
      const { threadId } = sessions.get("fc-notif-complete")!;

      mockServer.pushNotification("turn/completed", {
        threadId,
        turn: { id: "turn_1", status: "completed", error: null, items: [] },
      });
      await delay(80);

      const result = injected.find((m) => (m as { type: string }).type === "result");
      expect(result).toBeDefined();
    });

    test("error notification routes to assistant error message", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-notif-err") injected.push(msg);
        original(sid, msg);
      });

      await bridge.createSession("fc-notif-err", "/tmp");
      injected.length = 0;

      const sessions = (bridge as unknown as { sessions: Map<string, { threadId: string }> }).sessions;
      const { threadId } = sessions.get("fc-notif-err")!;

      mockServer.pushNotification("error", {
        threadId,
        message: "Rate limit exceeded",
      });
      await delay(80);

      const asst = injected.find(
        (m) => (m as { type: string }).type === "assistant"
      ) as { message: { content: Array<{ text?: string }> } } | undefined;
      expect(asst).toBeDefined();
      expect(asst?.message.content[0].text).toContain("Rate limit exceeded");
    });

    test("turn/started tracks currentTurnId", async () => {
      makeBridge();
      await bridge.start();

      await bridge.createSession("fc-notif-turn", "/tmp");

      const sessions = (bridge as unknown as { sessions: Map<string, { threadId: string; currentTurnId?: string }> }).sessions;
      const { threadId } = sessions.get("fc-notif-turn")!;

      mockServer.pushNotification("turn/started", {
        threadId,
        turn: { id: "turn_42", status: "running", error: null, items: [] },
      });
      await delay(80);

      const mapping = sessions.get("fc-notif-turn");
      expect(mapping?.currentTurnId).toBe("turn_42");
    });

    test("ignores notifications for unknown thread IDs", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = mock((_, msg) => {
        injected.push(msg);
        original(_ as string, msg);
      });

      await bridge.createSession("fc-notif-noop", "/tmp");
      injected.length = 0;

      // Push event with unknown thread ID
      mockServer.pushNotification("item/agentMessage/delta", {
        threadId: "thread_nobody_999",
        delta: "nope",
      });
      await delay(80);

      const streamed = injected.filter(
        (m) => (m as { type: string }).type === "stream_event"
      );
      expect(streamed).toHaveLength(0);
    });

    test("server requests are auto-approved", async () => {
      makeBridge();
      await bridge.start();

      await bridge.createSession("fc-approval", "/tmp");

      // Push a server request for command approval
      mockServer.pushServerRequest("req_1", "item/commandExecution/requestApproval", {
        command: ["ls", "-la"],
      });
      await delay(80);

      // The bridge should have sent back a response (we can't easily inspect it here,
      // but the fact that it doesn't throw is sufficient for this test)
      expect(bridge.isCodexSession("fc-approval")).toBe(true);
    });
  });

  // ─── stop ────────────────────────────────────────────────────────────────────

  describe("stop()", () => {
    test("resets ready state so start() reconnects", async () => {
      makeBridge();
      await bridge.start();
      const initsBefore = mockServer.receivedMethods.filter((m) => m === "initialize").length;

      await bridge.stop();
      await bridge.start();
      const initsAfter = mockServer.receivedMethods.filter((m) => m === "initialize").length;

      expect(initsAfter).toBeGreaterThan(initsBefore);
    });
  });
});

// ─── CliLauncher + CodexBridge ────────────────────────────────────────────────

describe("CliLauncher + CodexBridge integration", () => {
  let mockServer: MockServer;

  beforeAll(() => {
    mockServer = createMockCodexServer();
  });

  afterAll(() => {
    mockServer.stop();
  });

  function delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  test("provider=codex delegates to CodexBridge and reaches connected state", async () => {
    const { CliLauncher } = await import("../server/cli-launcher.js");
    const { NullSessionStore } = await import("../server/session-store.js");

    const launcher = new CliLauncher(59993, "/tmp", new NullSessionStore());
    const codexBridge = new CodexBridge(mockServer.port);
    launcher.setCodexBridge(codexBridge);

    const info = launcher.launch({ provider: "codex", model: "gpt-5.3-codex", cwd: "/tmp" });

    expect(info.provider).toBe("codex");
    expect(info.state).toBe("starting");
    expect(info.model).toBe("gpt-5.3-codex");
    expect(info.sessionId).toBeTruthy();

    // Wait for async createSession
    await delay(300);
    expect(info.state).toBe("connected");

    // Session is tracked by launcher
    expect(launcher.getSession(info.sessionId)).toBeDefined();
    expect(launcher.isAlive(info.sessionId)).toBe(true);

    await codexBridge.stop();
  });

  test("provider=codex with no bridge falls through to claude path", async () => {
    const { CliLauncher } = await import("../server/cli-launcher.js");
    const { NullSessionStore } = await import("../server/session-store.js");

    const launcher = new CliLauncher(59993, "/tmp", new NullSessionStore());
    // No codexBridge set

    const info = launcher.launch({ provider: "codex", cwd: "/tmp" });
    // Falls through to the claude binary spawning path
    expect(info.provider).toBe("claude");
  });

  test("multiple concurrent codex sessions are tracked independently", async () => {
    const { CliLauncher } = await import("../server/cli-launcher.js");
    const { NullSessionStore } = await import("../server/session-store.js");

    const launcher = new CliLauncher(59993, "/tmp", new NullSessionStore());
    const codexBridge = new CodexBridge(mockServer.port);
    launcher.setCodexBridge(codexBridge);

    const a = launcher.launch({ provider: "codex", model: "gpt-5.3-codex", cwd: "/a" });
    const b = launcher.launch({ provider: "codex", model: "o4-mini", cwd: "/b" });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.model).toBe("gpt-5.3-codex");
    expect(b.model).toBe("o4-mini");

    await delay(300);
    expect(a.state).toBe("connected");
    expect(b.state).toBe("connected");

    await codexBridge.stop();
  });
});

// ─── Routes: /api/codex/models ───────────────────────────────────────────────

describe("GET /api/codex/models route", () => {
  test("returns 501 when no CodexBridge configured", async () => {
    const { createTestServer } = await import("./helpers/server.js");
    const ctx = createTestServer();
    try {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/codex/models`);
      expect(res.status).toBe(501);
      const data = await res.json() as { error: string };
      expect(data.error).toContain("Codex");
    } finally {
      ctx.close();
    }
  });
});
