import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestServer, type TestContext } from "./helpers/server.js";
import { MockCLIClient } from "./helpers/mock-cli-client.js";
import { MockBrowserClient } from "./helpers/mock-browser-client.js";
import {
  makeSystemInit, makeAssistantMessage, makeResultMessage, makeControlRequest,
  makeStreamEvent, makeToolProgress, makeToolUseSummary, makeAuthStatus,
  makeSystemStatus, makeResultMessageWithUsage, makeKeepAlive,
} from "./helpers/fixtures.js";
import { delay } from "./helpers/wait.js";

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

describe("WebSocket Bridge", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
  });

  // ─── Basic Routing ──────────────────────────────────────────────

  describe("basic routing", () => {
    test("browser receives session_init on connect", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      const msg = await browser.waitForMessage("session_init");
      expect(msg.type).toBe("session_init");
      const session = msg.session as Record<string, unknown>;
      expect(session.session_id).toBe(sessionId);

      browser.close();
    });

    test("browser receives cli_disconnected when no CLI is connected", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      const msg = await browser.waitForMessage("cli_disconnected");
      expect(msg.type).toBe("cli_disconnected");

      browser.close();
    });

    test("browser receives cli_connected when CLI connects", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      // Drain initial messages
      await browser.waitForMessage("session_init");
      await browser.waitForMessage("cli_disconnected");

      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const msg = await browser.waitForMessage("cli_connected");
      expect(msg.type).toBe("cli_connected");

      cli.close();
      browser.close();
    });

    test("CLI system init updates browser session state", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      // First session_init has default state
      await browser.waitForMessage("session_init");

      // CLI sends system init
      cli.send(makeSystemInit({ session_id: sessionId, model: "opus", cwd: "/home/test" }));

      // Browser receives updated session_init
      const msg = await browser.waitForMessage("session_init");
      const session = msg.session as Record<string, unknown>;
      expect(session.model).toBe("opus");
      expect(session.cwd).toBe("/home/test");

      cli.close();
      browser.close();
    });

    test("CLI assistant message is forwarded to browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeAssistantMessage("Hello world"));

      const msg = await browser.waitForMessage("assistant");
      expect(msg.type).toBe("assistant");
      const message = msg.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      expect(content[0].text).toBe("Hello world");

      cli.close();
      browser.close();
    });

    test("CLI result message is forwarded with cost/turns", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeResultMessage({ total_cost_usd: 0.05, num_turns: 3 }));

      const msg = await browser.waitForMessage("result");
      const data = msg.data as Record<string, unknown>;
      expect(data.total_cost_usd).toBe(0.05);
      expect(data.num_turns).toBe(3);

      cli.close();
      browser.close();
    });

    test("browser user_message is forwarded to CLI as NDJSON", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({ type: "user_message", content: "what is 2+2?" });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("user");
      const message = cliMsg.message as Record<string, unknown>;
      expect(message.role).toBe("user");
      expect(message.content).toBe("what is 2+2?");

      cli.close();
      browser.close();
    });

    test("stream events are forwarded to browser but NOT stored in history", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Send a stream event + an assistant message
      cli.send(makeStreamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "He" } }));
      cli.send(makeAssistantMessage("Hello"));

      await browser1.waitForMessage("stream_event");
      await browser1.waitForMessage("assistant");
      browser1.close();

      // New browser should get history with assistant but NOT stream_event
      await delay(50);
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

  // ─── Message Queuing ────────────────────────────────────────────

  describe("message queuing", () => {
    test("user message is queued when CLI not connected, flushed on CLI connect", async () => {
      const sessionId = await createSession(ctx);

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send user message before CLI connects
      browser.send({ type: "user_message", content: "hello from queue" });
      await delay(50);

      // Now connect CLI — queued message should flush
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("user");
      const message = cliMsg.message as Record<string, unknown>;
      expect(message.content).toBe("hello from queue");

      cli.close();
      browser.close();
    });

    test("multiple queued messages are flushed in order", async () => {
      const sessionId = await createSession(ctx);

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({ type: "user_message", content: "first" });
      browser.send({ type: "user_message", content: "second" });
      browser.send({ type: "user_message", content: "third" });
      await delay(50);

      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const msg1 = await cli.nextMessage();
      const msg2 = await cli.nextMessage();
      const msg3 = await cli.nextMessage();

      expect((msg1.message as any).content).toBe("first");
      expect((msg2.message as any).content).toBe("second");
      expect((msg3.message as any).content).toBe("third");

      cli.close();
      browser.close();
    });
  });

  // ─── Permission Flow ──────────────────────────────────────────

  describe("permissions", () => {
    test("CLI permission request is forwarded to browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Bash", { command: "ls -la" });
      cli.send(permReq);

      const msg = await browser.waitForMessage("permission_request");
      const request = msg.request as Record<string, unknown>;
      expect(request.tool_name).toBe("Bash");
      expect(request.input).toEqual({ command: "ls -la" });
      expect(request.request_id).toBe(permReq.request_id);

      cli.close();
      browser.close();
    });

    test("browser allow is forwarded to CLI as control_response", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Write", { file_path: "/tmp/test.txt", content: "hello" });
      cli.send(permReq);
      await browser.waitForMessage("permission_request");

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
      const inner = response.response as Record<string, unknown>;
      expect(inner.behavior).toBe("allow");

      cli.close();
      browser.close();
    });

    test("browser deny is forwarded to CLI", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Bash", { command: "rm -rf /" });
      cli.send(permReq);
      await browser.waitForMessage("permission_request");

      browser.send({
        type: "permission_response",
        request_id: permReq.request_id,
        behavior: "deny",
        message: "Too dangerous",
      });

      const cliMsg = await cli.nextMessage();
      const response = cliMsg.response as Record<string, unknown>;
      const inner = response.response as Record<string, unknown>;
      expect(inner.behavior).toBe("deny");
      expect(inner.message).toBe("Too dangerous");

      cli.close();
      browser.close();
    });

    test("CLI disconnect cancels pending permissions", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const permReq = makeControlRequest("Bash", { command: "echo hi" });
      cli.send(permReq);
      await browser.waitForMessage("permission_request");

      // Close CLI
      cli.close();

      const cancelled = await browser.waitForMessage("permission_cancelled");
      expect(cancelled.request_id).toBe(permReq.request_id);

      await browser.waitForMessage("cli_disconnected");

      browser.close();
    });
  });

  // ─── History Replay ─────────────────────────────────────────────

  describe("history replay", () => {
    test("new browser receives message history from prior conversation", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Build up some history
      cli.send(makeSystemInit({ session_id: sessionId }));
      await browser1.waitForMessage("session_init"); // updated init

      cli.send(makeAssistantMessage("Hello!"));
      await browser1.waitForMessage("assistant");

      browser1.send({ type: "user_message", content: "Thanks!" });
      await cli.nextMessage(); // consume the forwarded user message

      cli.send(makeResultMessage({ total_cost_usd: 0.02 }));
      await browser1.waitForMessage("result");

      browser1.close();
      await delay(50);

      // New browser should get the full history
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      await browser2.waitForMessage("session_init");
      const historyMsg = await browser2.waitForMessage("message_history");
      const messages = historyMsg.messages as Array<Record<string, unknown>>;

      // Should contain: assistant, user_message, result
      const types = messages.map((m) => m.type);
      expect(types).toContain("assistant");
      expect(types).toContain("user_message");
      expect(types).toContain("result");

      browser2.close();
      cli.close();
    });

    test("pending permissions are replayed to new browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      const permReq = makeControlRequest("Bash", { command: "test" });
      cli.send(permReq);
      await browser1.waitForMessage("permission_request");

      // Second browser connects — should also get the pending permission
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      const replayedPerm = await browser2.waitForMessage("permission_request");
      const request = replayedPerm.request as Record<string, unknown>;
      expect(request.request_id).toBe(permReq.request_id);

      browser1.close();
      browser2.close();
      cli.close();
    });
  });

  // ─── Multiple Browsers ──────────────────────────────────────────

  describe("multi-browser", () => {
    test("CLI message is broadcast to all connected browsers", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      cli.send(makeAssistantMessage("Broadcast test"));

      const msg1 = await browser1.waitForMessage("assistant");
      const msg2 = await browser2.waitForMessage("assistant");

      expect((msg1.message as any).content[0].text).toBe("Broadcast test");
      expect((msg2.message as any).content[0].text).toBe("Broadcast test");

      cli.close();
      browser1.close();
      browser2.close();
    });

    test("disconnecting one browser does not affect the other", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      // Disconnect browser1
      browser1.close();
      await delay(50);

      // browser2 should still receive messages
      cli.send(makeAssistantMessage("Still here"));
      const msg = await browser2.waitForMessage("assistant");
      expect((msg.message as any).content[0].text).toBe("Still here");

      cli.close();
      browser2.close();
    });
  });

  // ─── CLI Message Types ─────────────────────────────────────────

  describe("CLI message types", () => {
    test("tool_progress is forwarded to browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const toolUseId = "toolu_test123";
      cli.send(makeToolProgress("Bash", { tool_use_id: toolUseId, elapsed_time_seconds: 5.2 }));

      const msg = await browser.waitForMessage("tool_progress");
      expect(msg.tool_use_id).toBe(toolUseId);
      expect(msg.tool_name).toBe("Bash");
      expect(msg.elapsed_time_seconds).toBe(5.2);

      cli.close();
      browser.close();
    });

    test("tool_use_summary is forwarded to browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      const ids = ["toolu_1", "toolu_2"];
      cli.send(makeToolUseSummary("Read 2 files", ids));

      const msg = await browser.waitForMessage("tool_use_summary");
      expect(msg.summary).toBe("Read 2 files");
      expect(msg.tool_use_ids).toEqual(ids);

      cli.close();
      browser.close();
    });

    test("auth_status is forwarded to browser", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeAuthStatus({ isAuthenticating: true, output: ["Please log in"] }));

      const msg = await browser.waitForMessage("auth_status");
      expect(msg.isAuthenticating).toBe(true);
      expect(msg.output).toEqual(["Please log in"]);

      cli.close();
      browser.close();
    });

    test("system status (compacting) is forwarded as status_change", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeSystemStatus({ status: "compacting" }));

      const msg = await browser.waitForMessage("status_change");
      expect(msg.status).toBe("compacting");

      cli.close();
      browser.close();
    });

    test("result with modelUsage computes context_used_percent", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      cli.send(makeResultMessageWithUsage({ total_cost_usd: 0.10, num_turns: 5 }));

      await browser.waitForMessage("result");

      // Connect a second browser to get the session snapshot with updated state
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      // (8000 + 2000) / 200000 = 5%
      expect(session.context_used_percent).toBe(5);
      expect(session.total_cost_usd).toBe(0.10);
      expect(session.num_turns).toBe(5);

      cli.close();
      browser.close();
      browser2.close();
    });
  });

  // ─── Browser Commands ──────────────────────────────────────────

  describe("browser commands", () => {
    test("interrupt is forwarded to CLI as control_request", async () => {
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

    test("set_model is forwarded to CLI", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({ type: "set_model", model: "claude-opus-4-6" });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("control_request");
      const request = cliMsg.request as Record<string, unknown>;
      expect(request.subtype).toBe("set_model");
      expect(request.model).toBe("claude-opus-4-6");

      cli.close();
      browser.close();
    });

    test("set_permission_mode is forwarded to CLI", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({ type: "set_permission_mode", mode: "plan" });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("control_request");
      const request = cliMsg.request as Record<string, unknown>;
      expect(request.subtype).toBe("set_permission_mode");
      expect(request.mode).toBe("plan");

      cli.close();
      browser.close();
    });

    test("user message with images sends content blocks to CLI", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      browser.send({
        type: "user_message",
        content: "What is in this image?",
        images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }],
      });

      const cliMsg = await cli.nextMessage();
      expect(cliMsg.type).toBe("user");
      const message = cliMsg.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      // Should have image block + text block
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("image");
      expect(content[1].type).toBe("text");
      expect((content[1] as any).text).toBe("What is in this image?");

      cli.close();
      browser.close();
    });
  });

  // ─── Session Management ────────────────────────────────────────

  describe("session management", () => {
    test("restoreSession populates state and history for new browser", async () => {
      const sessionId = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";

      // Restore directly into the bridge (no REST create needed)
      ctx.bridge.restoreSession(sessionId, {
        session_id: sessionId,
        model: "opus",
        cwd: "/restored",
        tools: ["Read"],
        permissionMode: "default",
        claude_code_version: "1.0.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.50,
        num_turns: 10,
        context_used_percent: 25,
        is_compacting: false,
      }, [
        { type: "user_message", content: "Previously said", timestamp: 1000 },
        { type: "assistant", message: { id: "m1", type: "message", role: "assistant", model: "opus", content: [{ type: "text", text: "Previous reply" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, parent_tool_use_id: null },
      ]);

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      const initMsg = await browser.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;
      expect(session.model).toBe("opus");
      expect(session.cwd).toBe("/restored");
      expect(session.total_cost_usd).toBe(0.50);

      const historyMsg = await browser.waitForMessage("message_history");
      const messages = historyMsg.messages as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe("user_message");
      expect(messages[1].type).toBe("assistant");

      // Should also get cli_disconnected since no CLI is connected
      const disconnected = await browser.waitForMessage("cli_disconnected");
      expect(disconnected.type).toBe("cli_disconnected");

      browser.close();
    });

    test("removeSession makes session unreachable", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send a message to build history
      cli.send(makeAssistantMessage("Hello"));
      await browser.waitForMessage("assistant");

      browser.close();
      cli.close();
      await delay(50);

      // Remove the session
      ctx.bridge.removeSession(sessionId);

      // New browser should get empty state (fresh session created by getOrCreateSession)
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;
      expect(session.model).toBe(""); // default empty state

      browser2.close();
    });

    test("closeSession clears the session completely", async () => {
      const sessionId = await createSession(ctx);

      // Connect a browser to create the session in the bridge
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Verify session exists in bridge
      const bridgeSession = ctx.bridge.getSession(sessionId);
      expect(bridgeSession).toBeDefined();

      ctx.bridge.closeSession(sessionId);

      // Session should be gone
      const gone = ctx.bridge.getSession(sessionId);
      expect(gone).toBeUndefined();

      // Browser socket was closed by closeSession
    });
  });

  // ─── Status Replay on Reconnect ────────────────────────────────
  //
  // These tests verify the stoplight fix: when a browser reconnects mid-session
  // (e.g. after a brief network blip), the server must replay the current running
  // status so the indicator doesn't flicker to idle/grey.

  describe("status replay on browser reconnect", () => {
    test("reconnecting browser receives status_change:running when session is running", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // CLI sends an assistant message — session is now "running"
      cli.send(makeAssistantMessage("Thinking..."));
      await browser1.waitForMessage("assistant");
      browser1.close();
      await delay(50);

      // A new browser connects while session is still in running state
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      // Should immediately receive a status_change:running replay
      const statusMsg = await browser2.waitForMessage("status_change");
      expect(statusMsg.status).toBe("running");

      browser2.close();
      cli.close();
    });

    test("reconnecting browser receives status_change:compacting when compacting", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // CLI signals compacting
      cli.send(makeSystemStatus({ status: "compacting" }));
      await browser1.waitForMessage("status_change");
      browser1.close();
      await delay(50);

      // Reconnecting browser should get the compacting status replayed
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      const statusMsg = await browser2.waitForMessage("status_change");
      expect(statusMsg.status).toBe("compacting");

      browser2.close();
      cli.close();
    });

    test("reconnecting browser does NOT get status_change replay when session is idle", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Run a full cycle: assistant → result (ends idle)
      cli.send(makeAssistantMessage("Done"));
      await browser1.waitForMessage("assistant");
      cli.send(makeResultMessage({ total_cost_usd: 0.01 }));
      await browser1.waitForMessage("result");
      browser1.close();
      await delay(50);

      // Reconnecting browser — session is idle, no status_change should follow session_init
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");
      await browser2.waitForMessage("message_history");

      // Confirm no status_change arrives (use a small timeout)
      const nothing = await browser2.waitForMessage("status_change", 150).catch(() => null);
      expect(nothing).toBeNull();

      browser2.close();
      cli.close();
    });

    test("reconnecting browser during permission prompt gets pending perms AND running status", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Simulate: assistant message → then permission request (running + waiting)
      cli.send(makeAssistantMessage("About to use a tool"));
      await browser1.waitForMessage("assistant");

      const permReq = makeControlRequest("Bash", { command: "ls" });
      cli.send(permReq);
      await browser1.waitForMessage("permission_request");
      browser1.close();
      await delay(50);

      // Reconnect — should get status replay (running) AND permission replay
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");
      await browser2.waitForMessage("message_history");

      // Permission replay
      const permReplay = await browser2.waitForMessage("permission_request");
      expect((permReplay.request as Record<string, unknown>).request_id).toBe(permReq.request_id);

      // Status replay
      const statusReplay = await browser2.waitForMessage("status_change");
      expect(statusReplay.status).toBe("running");

      browser2.close();
      cli.close();
    });

    test("status resets to null after CLI disconnects mid-run", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Session starts running
      cli.send(makeAssistantMessage("Working..."));
      await browser.waitForMessage("assistant");

      // CLI drops (e.g. crash mid-run)
      cli.close();
      await browser.waitForMessage("cli_disconnected");
      browser.close();
      await delay(50);

      // A new browser connects — CLI is gone, should NOT get a running status replay
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();
      await browser2.waitForMessage("session_init");

      // Should receive cli_disconnected (not a status_change)
      const disc = await browser2.waitForMessage("cli_disconnected");
      expect(disc.type).toBe("cli_disconnected");

      const noStatus = await browser2.waitForMessage("status_change", 150).catch(() => null);
      expect(noStatus).toBeNull();

      browser2.close();
    });
  });
});
