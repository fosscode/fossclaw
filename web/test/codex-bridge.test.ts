/**
 * Unit tests for CodexBridge
 *
 * Uses a real in-process Bun.serve() mock to simulate a Codex server,
 * so we test the actual fetch/SSE logic without needing a real codex binary.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { CodexBridge } from "../server/codex-bridge.js";
import { WsBridge } from "../server/ws-bridge.js";

// ─── Mock Codex server ────────────────────────────────────────────────────────

interface MockServer {
  port: number;
  stop: () => void;
  requests: string[];
  sessions: Map<string, { id: string; cwd: string; model?: string }>;
  sseClients: Set<ReadableStreamDefaultController>;
  /** Push a raw SSE data event to all connected clients */
  pushEvent: (data: Record<string, unknown>) => void;
}

function createMockCodexServer(): MockServer {
  const requests: string[] = [];
  const sessions = new Map<string, { id: string; cwd: string; model?: string }>();
  const sseClients = new Set<ReadableStreamDefaultController>();
  let idSeq = 0;

  const pushEvent = (data: Record<string, unknown>) => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
    for (const ctrl of sseClients) {
      try { ctrl.enqueue(bytes); } catch { /* disconnected */ }
    }
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      requests.push(`${req.method} ${path}`);

      if (req.method === "GET" && path === "/health") {
        return Response.json({ ok: true });
      }

      if (req.method === "GET" && path === "/models") {
        return Response.json({
          models: [
            { id: "gpt-4o", name: "GPT-4o" },
            { id: "o4-mini", name: "o4-mini" },
          ],
        });
      }

      if (req.method === "GET" && path === "/events") {
        let ctrl!: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) { ctrl = c; sseClients.add(ctrl); },
          cancel() { sseClients.delete(ctrl); },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      if (req.method === "POST" && path === "/session") {
        const body = await req.json() as { cwd?: string; model?: string };
        const id = `ses_${++idSeq}`;
        sessions.set(id, { id, cwd: body.cwd || "/tmp", model: body.model });
        return Response.json({ id });
      }

      if (req.method === "POST" && path.match(/^\/session\/[^/]+\/message$/)) {
        return Response.json({ ok: true });
      }

      if (req.method === "POST" && path.match(/^\/session\/[^/]+\/interrupt$/)) {
        return Response.json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return { port: server.port, stop: () => server.stop(true), requests, sessions, sseClients, pushEvent };
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
    mockServer.requests.length = 0;
    mockServer.sessions.clear();
  });

  function makeBridge() {
    bridge = new CodexBridge(mockServer.port);
    wsBridge = new WsBridge();
    bridge.setWsBridge(wsBridge);
    return bridge;
  }

  // ─── start / health ─────────────────────────────────────────────────────────

  describe("start()", () => {
    test("connects to already-running server without spawning", async () => {
      makeBridge();
      await bridge.start();
      expect(mockServer.requests).toContain("GET /health");
    });

    test("idempotent — only hits health once", async () => {
      makeBridge();
      await bridge.start();
      await bridge.start();
      const healthHits = mockServer.requests.filter((r) => r === "GET /health");
      expect(healthHits.length).toBe(1);
    });
  });

  // ─── listModels ─────────────────────────────────────────────────────────────

  describe("listModels()", () => {
    test("returns models from server", async () => {
      makeBridge();
      const models = await bridge.listModels();
      expect(models.length).toBe(2);
      expect(models[0]).toEqual({ id: "gpt-4o", name: "GPT-4o" });
      expect(models[1]).toEqual({ id: "o4-mini", name: "o4-mini" });
      expect(mockServer.requests).toContain("GET /models");
    });

    test("handles OpenAI-style { data: [...] } response format", async () => {
      // Some Codex CLI versions return OpenAI-style { data: [...] }
      // Temporarily override the mock server's /models handler via a fresh bridge
      // pointing at a small one-shot server
      const tmpServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/health") return Response.json({ ok: true });
          if (url.pathname === "/models") {
            return Response.json({
              object: "list",
              data: [
                { id: "gpt-4o", name: "GPT-4o" },
                { id: "o1", name: "o1" },
              ],
            });
          }
          return new Response("Not found", { status: 404 });
        },
      });
      try {
        const b = new CodexBridge(tmpServer.port);
        const models = await b.listModels();
        expect(models.length).toBe(2);
        expect(models[0]).toEqual({ id: "gpt-4o", name: "GPT-4o" });
        expect(models[1]).toEqual({ id: "o1", name: "o1" });
        await b.stop();
      } finally {
        tmpServer.stop(true);
      }
    });

    test("returns empty array when server unreachable", async () => {
      // Use a port with nothing listening, manually mark ready
      const badBridge = new CodexBridge(59992);
      (badBridge as unknown as { ready: boolean }).ready = true;
      const models = await badBridge.listModels();
      expect(models).toEqual([]);
    });
  });

  // ─── createSession ──────────────────────────────────────────────────────────

  describe("createSession()", () => {
    test("POSTs to /session and returns mapping", async () => {
      makeBridge();
      const mapping = await bridge.createSession("fc-001", "/home/user", "gpt-4o");
      expect(mapping.fossclawId).toBe("fc-001");
      expect(mapping.codexId).toMatch(/^ses_/);
      expect(mapping.cwd).toBe("/home/user");
      expect(mapping.model).toBe("gpt-4o");
      expect(mockServer.requests).toContain("POST /session");
    });

    test("isCodexSession returns true after creation", async () => {
      makeBridge();
      await bridge.createSession("fc-002", "/tmp");
      expect(bridge.isCodexSession("fc-002")).toBe(true);
    });

    test("isCodexSession returns false for unknown id", async () => {
      makeBridge();
      expect(bridge.isCodexSession("nobody")).toBe(false);
    });

    test("works without model", async () => {
      makeBridge();
      const mapping = await bridge.createSession("fc-003", "/tmp");
      expect(mapping.model).toBeUndefined();
    });

    test("injects session_init via WsBridge", async () => {
      makeBridge();
      const injected: Array<{ sessionId: string; msg: unknown }> = [];
      const original = wsBridge.injectToBrowsers.bind(wsBridge);
      wsBridge.injectToBrowsers = (sid, msg) => {
        injected.push({ sessionId: sid, msg });
        original(sid, msg);
      };

      await bridge.createSession("fc-init", "/tmp", "gpt-4o");

      const init = injected.find(
        (i) => i.sessionId === "fc-init" && (i.msg as { type: string }).type === "session_init"
      );
      expect(init).toBeDefined();
    });
  });

  // ─── sendMessage ────────────────────────────────────────────────────────────

  describe("sendMessage()", () => {
    test("POSTs to /session/:id/message", async () => {
      makeBridge();
      const { codexId } = await bridge.createSession("fc-send-1", "/tmp", "gpt-4o");
      await bridge.sendMessage("fc-send-1", "hello world");
      expect(mockServer.requests).toContain(`POST /session/${codexId}/message`);
    });

    test("throws for unknown session", async () => {
      makeBridge();
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
      wsBridge.injectToBrowsers = mock((_, msg) => injected.push(msg));

      await bridge.createSession("fc-send-2", "/tmp");
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
    test("POSTs to /session/:id/interrupt", async () => {
      makeBridge();
      const { codexId } = await bridge.createSession("fc-abort-1", "/tmp");
      await bridge.abort("fc-abort-1");
      expect(mockServer.requests).toContain(`POST /session/${codexId}/interrupt`);
    });

    test("no-ops for unknown session", async () => {
      makeBridge();
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

  // ─── SSE event routing ───────────────────────────────────────────────────────

  describe("SSE events", () => {
    test("routes message.delta to correct session", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-sse-delta") injected.push(msg);
      });

      const { codexId } = await bridge.createSession("fc-sse-delta", "/tmp");
      await delay(150); // wait for SSE connection

      mockServer.pushEvent({ type: "message.delta", sessionId: codexId, delta: "Hello!" });
      await delay(80);

      const ev = injected.find(
        (m) => (m as { type: string }).type === "stream_event"
      ) as { event: { type: string; delta: { type: string; text: string } } } | undefined;
      expect(ev).toBeDefined();
      expect(ev?.event.delta.text).toBe("Hello!");
    });

    test("routes message.complete with text content", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-sse-complete") injected.push(msg);
      });

      const { codexId } = await bridge.createSession("fc-sse-complete", "/tmp");
      await delay(150);

      mockServer.pushEvent({
        type: "message.complete",
        sessionId: codexId,
        content: "The answer is 42.",
        id: "msg_001",
      });
      await delay(80);

      const asst = injected.find(
        (m) => (m as { type: string }).type === "assistant"
      ) as { message: { content: Array<{ type: string; text?: string }>; stop_reason: string } } | undefined;
      expect(asst).toBeDefined();
      expect(asst?.message.content[0].type).toBe("text");
      expect(asst?.message.content[0].text).toBe("The answer is 42.");
      expect(asst?.message.stop_reason).toBe("stop");

      const result = injected.find((m) => (m as { type: string }).type === "result");
      expect(result).toBeDefined();
    });

    test("routes message.complete with tool calls", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-sse-tool") injected.push(msg);
      });

      const { codexId } = await bridge.createSession("fc-sse-tool", "/tmp");
      await delay(150);

      mockServer.pushEvent({
        type: "message.complete",
        sessionId: codexId,
        tool_calls: [
          { id: "call_1", name: "bash", input: { cmd: "ls" }, output: "file.txt" },
        ],
        id: "msg_002",
      });
      await delay(80);

      const asst = injected.find(
        (m) => (m as { type: string }).type === "assistant"
      ) as { message: { content: Array<{ type: string }>; stop_reason: string } } | undefined;
      expect(asst).toBeDefined();
      const types = asst!.message.content.map((b) => b.type);
      expect(types).toContain("tool_use");
      expect(types).toContain("tool_result");
      expect(asst?.message.stop_reason).toBe("tool_use");
    });

    test("routes tool.start to tool_progress", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-sse-tprog") injected.push(msg);
      });

      const { codexId } = await bridge.createSession("fc-sse-tprog", "/tmp");
      await delay(150);

      mockServer.pushEvent({ type: "tool.start", sessionId: codexId, name: "bash", id: "call_x" });
      await delay(80);

      const prog = injected.find(
        (m) => (m as { type: string }).type === "tool_progress"
      ) as { tool_name: string } | undefined;
      expect(prog).toBeDefined();
      expect(prog?.tool_name).toBe("bash");
    });

    test("routes session.idle to result", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-sse-idle") injected.push(msg);
      });

      const { codexId } = await bridge.createSession("fc-sse-idle", "/tmp");
      await delay(150);

      mockServer.pushEvent({ type: "session.idle", sessionId: codexId });
      await delay(80);

      const result = injected.find((m) => (m as { type: string }).type === "result");
      expect(result).toBeDefined();
    });

    test("routes error event to assistant error message", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((sid, msg) => {
        if (sid === "fc-sse-err") injected.push(msg);
      });

      const { codexId } = await bridge.createSession("fc-sse-err", "/tmp");
      await delay(150);

      mockServer.pushEvent({ type: "error", sessionId: codexId, message: "Rate limit exceeded" });
      await delay(80);

      const asst = injected.find(
        (m) => (m as { type: string }).type === "assistant"
      ) as { message: { content: Array<{ text?: string }> } } | undefined;
      expect(asst).toBeDefined();
      expect(asst?.message.content[0].text).toContain("Rate limit exceeded");
    });

    test("ignores events for unknown session IDs", async () => {
      makeBridge();
      await bridge.start();

      const injected: unknown[] = [];
      wsBridge.injectToBrowsers = mock((_, msg) => injected.push(msg));

      await bridge.createSession("fc-sse-noop", "/tmp");
      await delay(150);

      // Push event with completely unknown session
      mockServer.pushEvent({ type: "message.delta", sessionId: "ses_nobody_999", delta: "nope" });
      await delay(80);

      // Only the session_init from createSession, nothing from the unknown event
      const streamed = injected.filter(
        (m) => (m as { type: string }).type === "stream_event"
      );
      expect(streamed).toHaveLength(0);
    });
  });

  // ─── stop ────────────────────────────────────────────────────────────────────

  describe("stop()", () => {
    test("resets ready state so start() reconnects", async () => {
      makeBridge();
      await bridge.start();
      const hits1 = mockServer.requests.filter((r) => r === "GET /health").length;

      await bridge.stop();
      await bridge.start();
      const hits2 = mockServer.requests.filter((r) => r === "GET /health").length;

      expect(hits2).toBeGreaterThan(hits1);
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

  test("provider=codex delegates to CodexBridge and reaches connected state", async () => {
    const { CliLauncher } = await import("../server/cli-launcher.js");
    const { NullSessionStore } = await import("../server/session-store.js");

    const launcher = new CliLauncher(59993, "/tmp", new NullSessionStore());
    const codexBridge = new CodexBridge(mockServer.port);
    launcher.setCodexBridge(codexBridge);

    const info = launcher.launch({ provider: "codex", model: "gpt-4o", cwd: "/tmp" });

    expect(info.provider).toBe("codex");
    expect(info.state).toBe("starting");
    expect(info.model).toBe("gpt-4o");
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

    const a = launcher.launch({ provider: "codex", model: "gpt-4o", cwd: "/a" });
    const b = launcher.launch({ provider: "codex", model: "o4-mini", cwd: "/b" });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.model).toBe("gpt-4o");
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
