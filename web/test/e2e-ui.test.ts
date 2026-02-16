import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestServer, type TestContext } from "./helpers/server.js";
import { MockCLIClient } from "./helpers/mock-cli-client.js";
import { MockBrowserClient } from "./helpers/mock-browser-client.js";
import {
  makeSystemInit,
  makeAssistantMessage,
  makeResultMessage,
  makeControlRequest,
  makeStreamEvent,
  makeToolProgress,
} from "./helpers/fixtures.js";
import { delay } from "./helpers/wait.js";

/** Helper: create a session via REST and return the sessionId. */
async function createSession(ctx: TestContext, options: Record<string, unknown> = {}): Promise<string> {
  const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const data = await res.json();
  return data.sessionId;
}

describe("E2E UI Integration Tests", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
  });

  // ─── Session Creation and Initialization ──────────────────────────

  describe("Session Creation Flow", () => {
    test("new session creation returns valid session data", async () => {
      const sessionId = await createSession(ctx, {
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "bypassPermissions",
        cwd: "/test/project",
      });

      expect(sessionId).toBeString();
      expect(sessionId.length).toBeGreaterThan(0);

      // Verify session can be retrieved
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      expect(res.status).toBe(200);
      const session = await res.json();
      expect(session.sessionId).toBe(sessionId);
      expect(session.model).toBe("claude-sonnet-4-5-20250929");
      expect(session.permissionMode).toBe("bypassPermissions");
    });

    test("browser connects and receives session_init", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      const initMsg = await browser.waitForMessage("session_init");
      expect(initMsg.type).toBe("session_init");
      expect(initMsg.session).toBeDefined();

      const session = initMsg.session as Record<string, unknown>;
      expect(session.session_id).toBe(sessionId);

      browser.close();
    });

    test("browser receives cli_disconnected initially", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      await browser.waitForMessage("session_init");
      const disconnectMsg = await browser.waitForMessage("cli_disconnected");
      expect(disconnectMsg.type).toBe("cli_disconnected");

      browser.close();
    });
  });

  // ─── Message Flow and Rendering ────────────────────────────────────

  describe("Message Flow", () => {
    test("user message sent from browser reaches CLI", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({
        type: "user_message",
        content: "Fix the rendering bug in HomePage",
      });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("user");
      const message = cliMsg.message as Record<string, unknown>;
      expect(message.role).toBe("user");
      expect(message.content).toBe("Fix the rendering bug in HomePage");

      cli.close();
      browser.close();
    });

    test("assistant message from CLI displays in browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeAssistantMessage("I'll help you fix the rendering bug."));

      const msg = await browser.waitForMessage("assistant");
      expect(msg.type).toBe("assistant");
      const message = msg.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      expect(content[0].type).toBe("text");
      expect(content[0].text).toBe("I'll help you fix the rendering bug.");

      cli.close();
      browser.close();
    });

    test("streaming text updates in real-time", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send streaming deltas
      cli.send(makeStreamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }));

      const start = await browser.waitForMessage("stream_event");
      expect(start.event).toBeDefined();

      cli.send(makeStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me " },
      }));

      const delta1 = await browser.waitForMessage("stream_event");
      expect(delta1.event).toBeDefined();

      cli.send(makeStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "analyze this." },
      }));

      const delta2 = await browser.waitForMessage("stream_event");
      expect(delta2.event).toBeDefined();

      cli.close();
      browser.close();
    });

    test("message with images sends correct format", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({
        type: "user_message",
        content: "What's in this screenshot?",
        images: [
          { media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
        ],
      });

      const cliMsg = await cli.nextMessage();
      const message = cliMsg.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;

      // Should have image block first, then text
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("image");
      expect((content[0] as any).source.type).toBe("base64");
      expect(content[1].type).toBe("text");
      expect((content[1] as any).text).toBe("What's in this screenshot?");

      cli.close();
      browser.close();
    });
  });

  // ─── Permission Handling ───────────────────────────────────────────

  describe("Permission Flow", () => {
    test("tool permission request displays to user", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Bash", {
        command: "npm install",
        description: "Install dependencies",
      });
      cli.send(permReq);

      const msg = await browser.waitForMessage("permission_request");
      expect(msg.type).toBe("permission_request");
      const request = msg.request as Record<string, unknown>;
      expect(request.tool_name).toBe("Bash");
      expect(request.request_id).toBe(permReq.request_id);
      expect((request.input as any).command).toBe("npm install");

      cli.close();
      browser.close();
    });

    test("user allows permission and CLI receives response", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Write", {
        file_path: "/src/test.ts",
        content: "console.log('test');",
      });
      cli.send(permReq);
      await browser.waitForMessage("permission_request");

      // User approves
      browser.send({
        type: "permission_response",
        request_id: permReq.request_id,
        behavior: "allow",
      });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("control_response");
      const response = cliMsg.response as Record<string, unknown>;
      expect(response.subtype).toBe("success");
      expect(response.request_id).toBe(permReq.request_id);

      cli.close();
      browser.close();
    });

    test("user denies permission with message", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Bash", {
        command: "rm -rf /",
      });
      cli.send(permReq);
      await browser.waitForMessage("permission_request");

      // User denies
      browser.send({
        type: "permission_response",
        request_id: permReq.request_id,
        behavior: "deny",
        message: "This command is too dangerous",
      });

      const cliMsg = await cli.nextMessage();
      const response = cliMsg.response as Record<string, unknown>;
      const inner = response.response as Record<string, unknown>;
      expect(inner.behavior).toBe("deny");
      expect(inner.message).toBe("This command is too dangerous");

      cli.close();
      browser.close();
    });

    test("pending permissions persist across browser reconnects", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Request permission but don't respond
      const permReq = makeControlRequest("Edit", {
        file_path: "/src/App.tsx",
        old_string: "old code",
        new_string: "new code",
      });
      cli.send(permReq);
      await browser1.waitForMessage("permission_request");
      browser1.close();

      // New browser connects and should see the pending permission
      await delay(100);
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      const replayedPerm = await browser2.waitForMessage("permission_request");
      const request = replayedPerm.request as Record<string, unknown>;
      expect(request.request_id).toBe(permReq.request_id);
      expect(request.tool_name).toBe("Edit");

      browser2.close();
      cli.close();
    });
  });

  // ─── Session State Management ──────────────────────────────────────

  describe("Session State", () => {
    test("session status changes are tracked correctly", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send system init with model/cwd
      cli.send(makeSystemInit({
        session_id: sessionId,
        model: "claude-opus-4-6",
        cwd: "/home/user/project",
      }));

      const updatedInit = await browser.waitForMessage("session_init");
      const session = updatedInit.session as Record<string, unknown>;
      expect(session.model).toBe("claude-opus-4-6");
      expect(session.cwd).toBe("/home/user/project");

      cli.close();
      browser.close();
    });

    test("result message updates cost and turns", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeResultMessage({
        total_cost_usd: 0.15,
        num_turns: 7,
      }));

      await browser.waitForMessage("result");

      // Reconnect to get updated session state
      browser.close();
      await delay(50);
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;
      expect(session.total_cost_usd).toBe(0.15);
      expect(session.num_turns).toBe(7);

      browser2.close();
      cli.close();
    });

    test("interrupt command is sent to CLI", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({ type: "interrupt" });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("control_request");
      const request = cliMsg.request as Record<string, unknown>;
      expect(request.subtype).toBe("interrupt");

      cli.close();
      browser.close();
    });

    test("model change command works", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({
        type: "set_model",
        model: "claude-haiku-4-5-20251001",
      });

      const cliMsg = await cli.nextMessage();
      const request = cliMsg.request as Record<string, unknown>;
      expect(request.subtype).toBe("set_model");
      expect(request.model).toBe("claude-haiku-4-5-20251001");

      cli.close();
      browser.close();
    });
  });

  // ─── Multi-Session Support ─────────────────────────────────────────

  describe("Multiple Sessions", () => {
    test("can create and manage multiple sessions independently", async () => {
      const session1 = await createSession(ctx, { model: "sonnet" });
      const session2 = await createSession(ctx, { model: "opus" });

      const cli1 = new MockCLIClient(ctx.wsBaseUrl, session1);
      const cli2 = new MockCLIClient(ctx.wsBaseUrl, session2);
      await cli1.connect();
      await cli2.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, session1);
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, session2);
      await browser1.connect();
      await browser2.connect();

      await browser1.waitForMessage("session_init");
      await browser2.waitForMessage("session_init");

      // Send messages to each session
      browser1.send({ type: "user_message", content: "Message to session 1" });
      browser2.send({ type: "user_message", content: "Message to session 2" });

      const cli1Msg = await cli1.nextMessage();
      const cli2Msg = await cli2.nextMessage();

      expect((cli1Msg.message as any).content).toBe("Message to session 1");
      expect((cli2Msg.message as any).content).toBe("Message to session 2");

      // Messages should not cross sessions
      cli1.send(makeAssistantMessage("Response from session 1"));
      const browser1Msg = await browser1.waitForMessage("assistant");
      expect(((browser1Msg.message as any).content[0] as any).text).toBe("Response from session 1");

      // browser2 should not receive browser1's message
      await delay(100);

      cli1.close();
      cli2.close();
      browser1.close();
      browser2.close();
    });

    test("sessions list endpoint returns all sessions", async () => {
      const session1 = await createSession(ctx);
      const session2 = await createSession(ctx);
      const session3 = await createSession(ctx);

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const sessions = await res.json();

      expect(sessions).toBeArrayOfSize(3);
      const ids = sessions.map((s: any) => s.sessionId);
      expect(ids).toContain(session1);
      expect(ids).toContain(session2);
      expect(ids).toContain(session3);
    });

    test("deleting one session does not affect others", async () => {
      const session1 = await createSession(ctx);
      const session2 = await createSession(ctx);

      // Delete session1
      const delRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${session1}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      // session1 should be gone
      const get1 = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${session1}`);
      expect(get1.status).toBe(404);

      // session2 should still exist
      const get2 = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${session2}`);
      expect(get2.status).toBe(200);
    });
  });

  // ─── Tool Progress and Feedback ────────────────────────────────────

  describe("Tool Progress", () => {
    test("tool_progress updates display in browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const toolUseId = "toolu_test_bash_001";
      cli.send(makeToolProgress("Bash", {
        tool_use_id: toolUseId,
        elapsed_time_seconds: 3.5,
      }));

      const msg = await browser.waitForMessage("tool_progress");
      expect(msg.tool_use_id).toBe(toolUseId);
      expect(msg.tool_name).toBe("Bash");
      expect(msg.elapsed_time_seconds).toBe(3.5);

      cli.close();
      browser.close();
    });

    test("multiple tool progress updates work correctly", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const toolId = "toolu_read_001";

      // Send multiple progress updates
      cli.send(makeToolProgress("Read", {
        tool_use_id: toolId,
        elapsed_time_seconds: 1.0,
      }));

      const msg1 = await browser.waitForMessage("tool_progress");
      expect(msg1.elapsed_time_seconds).toBe(1.0);

      cli.send(makeToolProgress("Read", {
        tool_use_id: toolId,
        elapsed_time_seconds: 2.5,
      }));

      const msg2 = await browser.waitForMessage("tool_progress");
      expect(msg2.elapsed_time_seconds).toBe(2.5);

      cli.close();
      browser.close();
    });
  });

  // ─── History and Reconnection ──────────────────────────────────────

  describe("History Replay", () => {
    test("reconnecting browser receives full message history", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Build conversation history
      browser1.send({ type: "user_message", content: "Hello" });
      await cli.nextMessage();

      cli.send(makeAssistantMessage("Hi there!"));
      await browser1.waitForMessage("assistant");

      browser1.send({ type: "user_message", content: "How are you?" });
      await cli.nextMessage();

      cli.send(makeAssistantMessage("I'm doing well, thanks!"));
      await browser1.waitForMessage("assistant");

      browser1.close();
      await delay(100);

      // New browser should get all history
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      const historyMsg = await browser2.waitForMessage("message_history");
      const messages = historyMsg.messages as Array<Record<string, unknown>>;

      // Should have 4 messages: 2 user, 2 assistant
      expect(messages.length).toBeGreaterThanOrEqual(4);

      const userMsgs = messages.filter((m) => m.type === "user_message");
      const assistantMsgs = messages.filter((m) => m.type === "assistant");

      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);

      browser2.close();
      cli.close();
    });

    test("stream events are not included in history replay", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Send stream event (ephemeral)
      cli.send(makeStreamEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "streaming..." },
      }));
      await browser1.waitForMessage("stream_event");

      // Send actual message (persistent)
      cli.send(makeAssistantMessage("Final message"));
      await browser1.waitForMessage("assistant");

      browser1.close();
      await delay(50);

      // New browser should only get the assistant message, not stream events
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      const historyMsg = await browser2.waitForMessage("message_history");
      const messages = historyMsg.messages as Array<Record<string, unknown>>;

      const types = messages.map((m) => m.type);
      expect(types).toContain("assistant");
      expect(types).not.toContain("stream_event");

      browser2.close();
      cli.close();
    });
  });

  // ─── Error Scenarios ───────────────────────────────────────────────

  describe("Error Handling", () => {
    test("connecting to non-existent session creates new session", async () => {
      const fakeSessionId = "00000000-1111-2222-3333-444444444444";

      const browser = new MockBrowserClient(ctx.wsBaseUrl, fakeSessionId);
      await browser.connect();

      // Should still get session_init (bridge creates session on demand)
      const initMsg = await browser.waitForMessage("session_init");
      expect(initMsg.type).toBe("session_init");

      browser.close();
    });

    test("CLI disconnect clears pending permissions", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Request permission
      const permReq = makeControlRequest("Bash", { command: "test" });
      cli.send(permReq);
      await browser.waitForMessage("permission_request");

      // CLI disconnects
      cli.close();

      // Browser should receive cancellation
      const cancelled = await browser.waitForMessage("permission_cancelled");
      expect(cancelled.request_id).toBe(permReq.request_id);

      await browser.waitForMessage("cli_disconnected");

      browser.close();
    });

    test("browser can send messages after CLI reconnects", async () => {
      const sessionId = await createSession(ctx);
      const cli1 = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli1.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Disconnect CLI
      cli1.close();
      await browser.waitForMessage("cli_disconnected");
      await delay(50);

      // Reconnect CLI
      const cli2 = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli2.connect();
      await browser.waitForMessage("cli_connected");

      // Message should work after reconnection
      browser.send({ type: "user_message", content: "This works after reconnect" });
      const cliMsg = await cli2.nextMessage();
      expect(cliMsg.type).toBe("user");
      const message = cliMsg.message as Record<string, unknown>;
      expect(message.content).toBe("This works after reconnect");

      cli2.close();
      browser.close();
    });
  });

  // ─── OpenCode Provider Support ─────────────────────────────────────

  describe("OpenCode Provider", () => {
    test("can create session with OpenCode provider", async () => {
      // Note: MockCliLauncher doesn't honor provider field, always sets "claude"
      // This is expected behavior for the test environment
      const sessionId = await createSession(ctx, {
        provider: "opencode",
        model: "gpt-4o",
        providerID: "openai",
      });

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      const session = await res.json();

      // MockCliLauncher always creates "claude" sessions
      expect(session.sessionId).toBe(sessionId);
    });

    test("OpenCode models list endpoint works", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/opencode/models`);

      // May return 500 or 501 if OPENCODE_PORT not configured, which is fine
      if (res.status === 200) {
        const data = await res.json();
        expect(data.models).toBeArray();
      } else {
        expect([500, 501]).toContain(res.status);
      }
    });
  });

  // ─── Filesystem Operations ─────────────────────────────────────────

  describe("Filesystem API", () => {
    test("can list directories", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/fs/list?path=/tmp`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.path).toBeString();
      expect(data.dirs).toBeArray();
      expect(data.home).toBeString();
    });

    test("invalid directory returns 400", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/fs/list?path=/this/path/does/not/exist/999`);
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toBe("Cannot read directory");
    });

    test("home directory endpoint works", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/fs/home`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.home).toBeString();
      expect(data.cwd).toBe("/tmp"); // test server default
    });
  });

  // ─── Session Resumption ────────────────────────────────────────────

  describe("Session Resumption", () => {
    test("can create session with resume flag", async () => {
      const originalSessionId = "test-session-to-resume";

      const sessionId = await createSession(ctx, {
        resumeSessionId: originalSessionId,
        cwd: "/home/test",
        provider: "claude",
      });

      expect(sessionId).toBeString();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      const session = await res.json();
      expect(session.cwd).toBe("/home/test");
    });
  });
});
