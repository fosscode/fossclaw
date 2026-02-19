import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestServer, type TestContext } from "./helpers/server.js";
import { MockCLIClient } from "./helpers/mock-cli-client.js";
import { MockBrowserClient } from "./helpers/mock-browser-client.js";
import { makeSystemInit, makeAssistantMessage, makeResultMessage } from "./helpers/fixtures.js";

/** Helper: create a session via REST and return the sessionId. */
async function createSession(ctx: TestContext): Promise<string> {
  const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  return data.sessionId;
}

describe("WsBridge Advanced Coverage", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
  });

  // ─── setPrefsStore / setOllama ──────────────────────────────────────

  describe("setPrefsStore and setOllama", () => {
    test("setPrefsStore doesn't crash", () => {
      // Create a minimal prefs store mock
      const mockPrefs = {
        load: async () => ({}),
        save: async () => {},
      };
      expect(() => ctx.bridge.setPrefsStore(mockPrefs as any)).not.toThrow();
    });

    test("setOllama with null doesn't crash", () => {
      expect(() => ctx.bridge.setOllama(null)).not.toThrow();
    });

    test("setOllama with client doesn't crash", () => {
      const mockOllama = { generateSessionName: async () => null, isAvailable: async () => true };
      expect(() => ctx.bridge.setOllama(mockOllama as any)).not.toThrow();
    });
  });

  // ─── removeSession ──────────────────────────────────────────────────

  describe("removeSession", () => {
    test("removes a session that exists", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      // Session should exist
      expect(ctx.bridge.getSession(sessionId)).toBeDefined();

      // Remove it
      ctx.bridge.removeSession(sessionId);

      // Session should be gone
      expect(ctx.bridge.getSession(sessionId)).toBeUndefined();

      cli.close();
    });

    test("removing nonexistent session doesn't crash", () => {
      expect(() => ctx.bridge.removeSession("nonexistent")).not.toThrow();
    });
  });

  // ─── External handlers ─────────────────────────────────────────────

  describe("registerExternalHandler / unregisterExternalHandler", () => {
    test("registers and unregisters handler", () => {
      const handler = () => {};
      ctx.bridge.registerExternalHandler("test-session", handler);
      ctx.bridge.unregisterExternalHandler("test-session");
      // Should not crash
    });

    test("unregister nonexistent handler doesn't crash", () => {
      expect(() => ctx.bridge.unregisterExternalHandler("nonexistent")).not.toThrow();
    });
  });

  // ─── injectToBrowsers ──────────────────────────────────────────────

  describe("injectToBrowsers", () => {
    test("injects message to connected browser", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      // Wait for session_init
      await browser.waitForMessage("session_init");

      // Inject a message via the bridge
      ctx.bridge.injectToBrowsers(sessionId, {
        type: "assistant_message",
        content: [{ type: "text", text: "Injected from external bridge" }],
      } as any);

      // Browser should receive it
      const msg = await browser.waitForMessage("assistant_message");
      expect(msg.type).toBe("assistant_message");

      browser.close();
    });

    test("injects to new session that doesn't exist yet", () => {
      // injectToBrowsers with getOrCreateSession creates the session
      ctx.bridge.injectToBrowsers("brand-new-session", {
        type: "assistant_message",
        content: [{ type: "text", text: "test" }],
      } as any);

      // Session should now exist
      expect(ctx.bridge.getSession("brand-new-session")).toBeDefined();
    });
  });

  // ─── closeSession ──────────────────────────────────────────────────

  describe("closeSession", () => {
    test("closes all sockets for a session", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Close the session
      ctx.bridge.closeSession(sessionId);

      // Session should be removed
      expect(ctx.bridge.getSession(sessionId)).toBeUndefined();
    });

    test("closing nonexistent session doesn't crash", () => {
      expect(() => ctx.bridge.closeSession("nonexistent")).not.toThrow();
    });
  });

  // ─── getAllSessions ─────────────────────────────────────────────────

  describe("getAllSessions", () => {
    test("returns all session states", async () => {
      const id1 = await createSession(ctx);
      const id2 = await createSession(ctx);

      const cli1 = new MockCLIClient(ctx.wsBaseUrl, id1);
      await cli1.connect();
      const cli2 = new MockCLIClient(ctx.wsBaseUrl, id2);
      await cli2.connect();

      const sessions = ctx.bridge.getAllSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(2);

      cli1.close();
      cli2.close();
    });
  });

  // ─── restoreSession ─────────────────────────────────────────────────

  describe("restoreSession", () => {
    test("restores an archived session with history", () => {
      const sessionId = "restored-session-123";
      const state = {
        session_id: sessionId,
        conversation: [],
        archived: false,
      };
      const history = [
        { type: "user_message" as const, content: "Hello", timestamp: Date.now() },
      ];

      ctx.bridge.restoreSession(sessionId, state as any, history as any, true);

      const session = ctx.bridge.getSession(sessionId);
      expect(session).toBeDefined();
      // The state should be marked as archived
      expect(session!.state.archived).toBe(true);
    });

    test("restores a non-archived session", () => {
      const sessionId = "restored-live-123";
      const state = {
        session_id: sessionId,
        conversation: [],
      };
      const history: any[] = [];

      ctx.bridge.restoreSession(sessionId, state as any, history, false);

      const session = ctx.bridge.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.state.archived).toBeUndefined();
    });
  });

  // ─── Activity tracking (onActivity callback) ───────────────────────

  describe("onActivity callback", () => {
    test("onActivity fires when CLI sends messages", async () => {
      let activitySessionId: string | null = null;
      ctx.bridge.onActivity = (id) => { activitySessionId = id; };

      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // System init first, then assistant message (which triggers updateActivity)
      cli.send(makeSystemInit({ session_id: sessionId }));
      await new Promise((r) => setTimeout(r, 50));
      cli.send(makeAssistantMessage("Hello from assistant"));

      // Wait for async WebSocket processing
      await new Promise((r) => setTimeout(r, 200));

      // The onActivity callback should have been called
      expect(activitySessionId).toBe(sessionId);

      browser.close();
      cli.close();
    });
  });
});
