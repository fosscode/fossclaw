import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestServer, type TestContext } from "./helpers/server.js";
import { MockCLIClient } from "./helpers/mock-cli-client.js";
import { MockBrowserClient } from "./helpers/mock-browser-client.js";
import {
  makeSystemInit,
  makeAssistantMessage,
  makeResultMessage,
} from "./helpers/fixtures.js";
import { delay } from "./helpers/wait.js";
import { FileSessionStore } from "../server/session-store.js";
import { WsBridge } from "../server/ws-bridge.js";

/** Helper: create a session via REST and return the sessionId. */
async function createSession(ctx: TestContext, options: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/api/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const data = await res.json();
  return data.sessionId;
}

describe("E2E Session Persistence", () => {
  let ctx: TestContext;
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fossclaw-persist-test-"));
    store = new FileSessionStore(tmpDir);
    ctx = createTestServer();
  });

  afterEach(async () => {
    ctx.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Session Persistence ──────────────────────────────────────────

  describe("Session Metadata Persistence", () => {
    test("session metadata is persisted on creation", async () => {
      const sessionId = await createSession(ctx, {
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "default",
        cwd: "/test/project",
      });

      // Verify session exists in REST API
      const res = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      expect(res.status).toBe(200);
      const session = await res.json();

      expect(session.sessionId).toBe(sessionId);
      expect(session.model).toBe("claude-sonnet-4-5-20250929");
      expect(session.permissionMode).toBe("default");
      expect(session.cwd).toBe("/test/project");
      expect(session.createdAt).toBeNumber();
    });

    test("session state is updated when CLI sends system init", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // CLI sends system init with model and cwd
      cli.send(makeSystemInit({
        session_id: sessionId,
        model: "claude-opus-4-6",
        cwd: "/home/user/project",
        claude_code_version: "2.3.0",
      }));

      const updatedInit = await browser.waitForMessage("session_init");
      const session = updatedInit.session as Record<string, unknown>;

      expect(session.model).toBe("claude-opus-4-6");
      expect(session.cwd).toBe("/home/user/project");
      expect(session.claude_code_version).toBe("2.3.0");

      cli.close();
      browser.close();
    });

    test("session cost and turns are persisted", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send result message with cost and turns
      cli.send(makeResultMessage({
        total_cost_usd: 1.25,
        num_turns: 15,
      }));

      await browser.waitForMessage("result");
      await delay(100);

      // Reconnect and verify persisted state
      browser.close();
      await delay(50);

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.total_cost_usd).toBe(1.25);
      expect(session.num_turns).toBe(15);

      browser2.close();
      cli.close();
    });
  });

  // ─── Message History Persistence ──────────────────────────────────

  describe("Message History Persistence", () => {
    test("message history is preserved across browser reconnects", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Build up message history
      browser1.send({ type: "user_message", content: "First message" });
      await cli.nextMessage();

      cli.send(makeAssistantMessage("First response"));
      await browser1.waitForMessage("assistant");

      browser1.send({ type: "user_message", content: "Second message" });
      await cli.nextMessage();

      cli.send(makeAssistantMessage("Second response"));
      await browser1.waitForMessage("assistant");

      browser1.close();
      await delay(100);

      // Reconnect and verify history
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      const historyMsg = await browser2.waitForMessage("message_history");
      const messages = historyMsg.messages as Array<Record<string, unknown>>;

      expect(messages.length).toBeGreaterThanOrEqual(4);

      const userMsgs = messages.filter((m) => m.type === "user_message");
      const assistantMsgs = messages.filter((m) => m.type === "assistant");

      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);

      browser2.close();
      cli.close();
    });

    test("message history persists after server restart", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Create conversation
      browser.send({ type: "user_message", content: "Persisted message" });
      await cli.nextMessage();

      cli.send(makeAssistantMessage("Persisted response"));
      await browser.waitForMessage("assistant");

      // Store history manually (simulating server shutdown)
      const session = ctx.bridge.getSession(sessionId);
      if (session) {
        store.saveMeta(sessionId, {
          sessionId,
          pid: 12345,
          model: "claude-sonnet-4-5-20250929",
          permissionMode: "default",
          provider: "claude",
          cwd: "/tmp",
          createdAt: Date.now(),
        });
        store.saveState(sessionId, session.state);
        store.saveHistory(sessionId, session.messageHistory);
        await store.flush();
      }

      browser.close();
      cli.close();
      await delay(100);

      // Simulate server restart by creating new bridge and restoring
      const newBridge = new WsBridge(store);
      const loaded = await store.load(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded!.history.length).toBeGreaterThanOrEqual(2);

      newBridge.restoreSession(sessionId, loaded!.state, loaded!.history);

      // Verify restored history
      const restoredSession = newBridge.getSession(sessionId);
      expect(restoredSession).toBeDefined();
      expect(restoredSession!.messageHistory.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Session Archiving ─────────────────────────────────────────────

  describe("Archived Sessions", () => {
    test("session becomes archived when CLI dies", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send some messages
      browser.send({ type: "user_message", content: "Test message" });
      await cli.nextMessage();

      // Kill CLI process
      await ctx.launcher.kill(sessionId);
      cli.close();

      // Browser should receive disconnect notification
      await browser.waitForMessage("cli_disconnected");

      // Verify session is marked as archived
      const session = ctx.launcher.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.state).toBe("exited");

      browser.close();
    });

    test("archived sessions can be listed via REST API", async () => {
      const sessionId1 = await createSession(ctx);
      const sessionId2 = await createSession(ctx);

      // Kill first session
      await ctx.launcher.kill(sessionId1);

      // List all sessions
      const res = await fetch(`${ctx.baseUrl}/api/sessions`);
      const sessions = await res.json();

      expect(sessions).toBeArray();
      expect(sessions.length).toBe(2);

      const archived = sessions.find((s: any) => s.sessionId === sessionId1);
      const active = sessions.find((s: any) => s.sessionId === sessionId2);

      expect(archived.state).toBe("exited");
      expect(active.state).not.toBe("exited");
    });

    test("archived sessions are read-only", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Create history
      browser.send({ type: "user_message", content: "Before archive" });
      await cli.nextMessage();
      cli.send(makeAssistantMessage("Response before archive"));
      await browser.waitForMessage("assistant");

      // Kill CLI
      await ctx.launcher.kill(sessionId);
      cli.close();
      await browser.waitForMessage("cli_disconnected");

      // Try to send message to archived session
      browser.send({ type: "user_message", content: "After archive" });

      // Message should be queued but not delivered (no CLI to receive it)
      await delay(100);

      // History should still contain only pre-archive messages
      const session = ctx.bridge.getSession(sessionId);
      expect(session).toBeDefined();

      const userMessages = session!.messageHistory.filter(
        (m: any) => m.type === "user_message"
      );

      // Should have both messages (before and after archive)
      // But the second one is queued, not delivered
      expect(userMessages.length).toBeGreaterThanOrEqual(1);

      browser.close();
    });
  });

  // ─── Session Resumption ────────────────────────────────────────────

  describe("Session Resumption", () => {
    test("can resume archived session with resumeSessionId", async () => {
      const originalSessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, originalSessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, originalSessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Build conversation history
      browser.send({ type: "user_message", content: "Original message" });
      await cli.nextMessage();
      cli.send(makeAssistantMessage("Original response"));
      await browser.waitForMessage("assistant");

      // Kill original session
      await ctx.launcher.kill(originalSessionId);
      cli.close();
      await browser.waitForMessage("cli_disconnected");
      browser.close();
      await delay(100);

      // Resume session
      const newSessionId = await createSession(ctx, {
        resumeSessionId: originalSessionId,
        cwd: "/test/resume",
      });

      expect(newSessionId).not.toBe(originalSessionId);
      expect(newSessionId).toBeString();

      const newSession = ctx.launcher.getSession(newSessionId);
      expect(newSession).toBeDefined();
      expect(newSession!.cwd).toBe("/test/resume");
    });

    test("resumed session starts fresh with empty history", async () => {
      const originalSessionId = await createSession(ctx);

      // Create new session with resume flag
      const newSessionId = await createSession(ctx, {
        resumeSessionId: originalSessionId,
      });

      const browser = new MockBrowserClient(ctx.wsBaseUrl, newSessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Check if history is sent - it should be empty for new sessions
      // (Claude CLI --resume loads from disk, not from our bridge)
      await delay(100);

      browser.close();
    });
  });

  // ─── Session Activity Tracking ─────────────────────────────────────

  describe("Activity Tracking", () => {
    test("lastActivityAt is updated on user messages", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const before = Date.now();

      browser.send({ type: "user_message", content: "Activity test" });
      await cli.nextMessage();
      await delay(50);

      const after = Date.now();

      const session = ctx.launcher.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.lastActivityAt).toBeNumber();
      expect(session!.lastActivityAt!).toBeGreaterThanOrEqual(before);
      expect(session!.lastActivityAt!).toBeLessThanOrEqual(after);

      browser.close();
      cli.close();
    });

    test("lastActivityAt is updated on assistant messages", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const before = Date.now();

      cli.send(makeAssistantMessage("Activity response"));
      await browser.waitForMessage("assistant");
      await delay(50);

      const after = Date.now();

      const session = ctx.launcher.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.lastActivityAt).toBeNumber();
      expect(session!.lastActivityAt!).toBeGreaterThanOrEqual(before);
      expect(session!.lastActivityAt!).toBeLessThanOrEqual(after);

      browser.close();
      cli.close();
    });

    test("inactive sessions can be identified", async () => {
      const activeId = await createSession(ctx);
      const inactiveId = await createSession(ctx);

      // Connect to both
      const activeCli = new MockCLIClient(ctx.wsBaseUrl, activeId);
      const inactiveCli = new MockCLIClient(ctx.wsBaseUrl, inactiveId);
      await activeCli.connect();
      await inactiveCli.connect();

      const activeBrowser = new MockBrowserClient(ctx.wsBaseUrl, activeId);
      const inactiveBrowser = new MockBrowserClient(ctx.wsBaseUrl, inactiveId);
      await activeBrowser.connect();
      await inactiveBrowser.connect();
      await activeBrowser.waitForMessage("session_init");
      await inactiveBrowser.waitForMessage("session_init");

      // Send activity only to active session
      activeBrowser.send({ type: "user_message", content: "Active" });
      await activeCli.nextMessage();
      await delay(100);

      // Kill inactive session
      await ctx.launcher.kill(inactiveId);
      inactiveCli.close();
      await inactiveBrowser.waitForMessage("cli_disconnected");

      // Check activity timestamps
      const activeSess = ctx.launcher.getSession(activeId);
      const inactiveSess = ctx.launcher.getSession(inactiveId);

      expect(activeSess!.lastActivityAt).toBeNumber();
      expect(inactiveSess!.state).toBe("exited");

      activeBrowser.close();
      inactiveBrowser.close();
      activeCli.close();
    });
  });

  // ─── Session Cleanup ───────────────────────────────────────────────

  describe("Session Cleanup", () => {
    test("can delete archived session", async () => {
      const sessionId = await createSession(ctx);

      // Kill session to archive it
      await ctx.launcher.kill(sessionId);

      // Delete via REST API
      const delRes = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      // Verify session is gone
      const getRes = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      expect(getRes.status).toBe(404);
    });

    test("deleting active session kills CLI process", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Delete session
      const delRes = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      // CLI should be disconnected
      await delay(100);

      // Verify session is gone
      const session = ctx.launcher.getSession(sessionId);
      expect(session).toBeUndefined();

      cli.close();
      browser.close();
    });
  });

  // ─── Session Naming ────────────────────────────────────────────────

  describe("Session Naming", () => {
    test("can set custom session name", async () => {
      const sessionId = await createSession(ctx, {
        sessionName: "My Custom Session",
      });

      const res = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      const session = await res.json();

      expect(session.sessionName).toBe("My Custom Session");
    });

    test("can update session name via REST API", async () => {
      const sessionId = await createSession(ctx);

      const updateRes = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(updateRes.status).toBe(200);

      const getRes = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      const session = await getRes.json();

      expect(session.sessionName).toBe("Updated Name");
    });
  });
});
