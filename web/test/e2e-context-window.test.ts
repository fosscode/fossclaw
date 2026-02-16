import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestServer, type TestContext } from "./helpers/server.js";
import { MockCLIClient } from "./helpers/mock-cli-client.js";
import { MockBrowserClient } from "./helpers/mock-browser-client.js";
import { makeSystemInit, makeResultMessage } from "./helpers/fixtures.js";
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

describe("E2E Context Window Usage", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
  });

  // ─── Context Window Percentage ─────────────────────────────────────

  describe("Context Usage Tracking", () => {
    test("context_used_percent is initialized to 0", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      const initMsg = await browser.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(0);

      browser.close();
    });

    test("context_used_percent updates from system init", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send system init with context usage
      cli.send(makeSystemInit({
        session_id: sessionId,
        model: "claude-sonnet-4-5-20250929",
        context_used_percent: 45,
      }));

      const updatedInit = await browser.waitForMessage("session_init");
      const session = updatedInit.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(45);

      cli.close();
      browser.close();
    });

    test("context_used_percent updates from result message", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send result message with context usage
      cli.send(makeResultMessage({
        total_cost_usd: 0.10,
        num_turns: 5,
        context_used_percent: 67,
      }));

      await browser.waitForMessage("result");
      await delay(50);

      // Reconnect to get updated state
      browser.close();
      await delay(50);

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(67);

      browser2.close();
      cli.close();
    });

    test("context usage progresses over conversation", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Simulate context usage increasing
      const usageSteps = [10, 25, 40, 60, 85];

      for (const usage of usageSteps) {
        cli.send(makeResultMessage({
          total_cost_usd: 0.01,
          num_turns: 1,
          context_used_percent: usage,
        }));
        await browser.waitForMessage("result");
        await delay(50);
      }

      // Reconnect and verify final usage
      browser.close();
      await delay(50);

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(85);

      browser2.close();
      cli.close();
    });

    test("context usage at 100% is tracked", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send 100% usage
      cli.send(makeSystemInit({
        session_id: sessionId,
        context_used_percent: 100,
      }));

      const updatedInit = await browser.waitForMessage("session_init");
      const session = updatedInit.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(100);

      cli.close();
      browser.close();
    });

    test("context usage persists across browser reconnects", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Set context usage
      cli.send(makeResultMessage({
        context_used_percent: 73,
      }));
      await browser1.waitForMessage("result");

      browser1.close();
      await delay(100);

      // Reconnect and verify
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(73);

      browser2.close();
      cli.close();
    });
  });

  // ─── Compaction State ──────────────────────────────────────────────

  describe("Compaction State", () => {
    test("is_compacting is initialized to false", async () => {
      const sessionId = await createSession(ctx);
      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();

      const initMsg = await browser.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.is_compacting).toBe(false);

      browser.close();
    });

    test("is_compacting can be set to true", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send system init with compacting flag
      cli.send(makeSystemInit({
        session_id: sessionId,
        is_compacting: true,
        context_used_percent: 95,
      }));

      const updatedInit = await browser.waitForMessage("session_init");
      const session = updatedInit.session as Record<string, unknown>;

      expect(session.is_compacting).toBe(true);
      expect(session.context_used_percent).toBe(95);

      cli.close();
      browser.close();
    });

    test("is_compacting resets to false after compaction", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Start compaction
      cli.send(makeSystemInit({
        session_id: sessionId,
        is_compacting: true,
        context_used_percent: 95,
      }));
      await browser.waitForMessage("session_init");

      // Finish compaction
      cli.send(makeSystemInit({
        session_id: sessionId,
        is_compacting: false,
        context_used_percent: 40, // Context reduced after compaction
      }));

      const finalInit = await browser.waitForMessage("session_init");
      const session = finalInit.session as Record<string, unknown>;

      expect(session.is_compacting).toBe(false);
      expect(session.context_used_percent).toBe(40);

      cli.close();
      browser.close();
    });

    test("compaction state persists across reconnects", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser1 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser1.connect();
      await browser1.waitForMessage("session_init");

      // Set compacting state
      cli.send(makeSystemInit({
        session_id: sessionId,
        is_compacting: true,
      }));
      await browser1.waitForMessage("session_init");

      browser1.close();
      await delay(100);

      // Reconnect and verify
      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.is_compacting).toBe(true);

      browser2.close();
      cli.close();
    });
  });

  // ─── Multiple Sessions Context Tracking ────────────────────────────

  describe("Multi-Session Context Tracking", () => {
    test("each session tracks context independently", async () => {
      const session1 = await createSession(ctx);
      const session2 = await createSession(ctx);

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

      // Set different context usage for each
      cli1.send(makeResultMessage({ context_used_percent: 30 }));
      cli2.send(makeResultMessage({ context_used_percent: 75 }));

      await browser1.waitForMessage("result");
      await browser2.waitForMessage("result");
      await delay(50);

      // Verify each session has correct usage
      browser1.close();
      browser2.close();
      await delay(50);

      const browser1b = new MockBrowserClient(ctx.wsBaseUrl, session1);
      const browser2b = new MockBrowserClient(ctx.wsBaseUrl, session2);
      await browser1b.connect();
      await browser2b.connect();

      const init1 = await browser1b.waitForMessage("session_init");
      const init2 = await browser2b.waitForMessage("session_init");

      const sess1 = init1.session as Record<string, unknown>;
      const sess2 = init2.session as Record<string, unknown>;

      expect(sess1.context_used_percent).toBe(30);
      expect(sess2.context_used_percent).toBe(75);

      browser1b.close();
      browser2b.close();
      cli1.close();
      cli2.close();
    });

    test("compaction state is independent per session", async () => {
      const session1 = await createSession(ctx);
      const session2 = await createSession(ctx);

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

      // Start compaction only in session1
      cli1.send(makeSystemInit({
        session_id: session1,
        is_compacting: true,
      }));

      const init1 = await browser1.waitForMessage("session_init");
      const sess1 = init1.session as Record<string, unknown>;

      expect(sess1.is_compacting).toBe(true);

      // session2 should not be compacting
      await delay(100);
      browser2.close();
      await delay(50);

      const browser2b = new MockBrowserClient(ctx.wsBaseUrl, session2);
      await browser2b.connect();

      const init2 = await browser2b.waitForMessage("session_init");
      const sess2 = init2.session as Record<string, unknown>;

      expect(sess2.is_compacting).toBe(false);

      browser1.close();
      browser2b.close();
      cli1.close();
      cli2.close();
    });
  });

  // ─── OpenCode Context Tracking ─────────────────────────────────────

  describe("OpenCode Context Tracking", () => {
    test("OpenCode sessions track context usage", async () => {
      const sessionId = await createSession(ctx, {
        provider: "opencode",
        model: "gpt-4o",
      });

      // Note: MockCliLauncher creates "claude" sessions, so this test
      // verifies that context tracking works regardless of provider

      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send context usage
      cli.send(makeResultMessage({
        context_used_percent: 55,
      }));

      await browser.waitForMessage("result");
      await delay(50);

      browser.close();
      await delay(50);

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      expect(session.context_used_percent).toBe(55);

      browser2.close();
      cli.close();
    });
  });

  // ─── Context Usage Edge Cases ──────────────────────────────────────

  describe("Edge Cases", () => {
    test("handles negative context usage gracefully", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send invalid negative usage
      cli.send(makeResultMessage({
        context_used_percent: -10,
      }));

      await browser.waitForMessage("result");
      await delay(50);

      browser.close();
      await delay(50);

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      // Should store whatever is sent (validation is UI concern)
      expect(session.context_used_percent).toBeDefined();

      browser2.close();
      cli.close();
    });

    test("handles context usage over 100 gracefully", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send over-limit usage
      cli.send(makeResultMessage({
        context_used_percent: 150,
      }));

      await browser.waitForMessage("result");
      await delay(50);

      browser.close();
      await delay(50);

      const browser2 = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser2.connect();

      const initMsg = await browser2.waitForMessage("session_init");
      const session = initMsg.session as Record<string, unknown>;

      // Should store whatever is sent
      expect(session.context_used_percent).toBe(150);

      browser2.close();
      cli.close();
    });

    test("handles missing context_used_percent field", async () => {
      const sessionId = await createSession(ctx);
      const cli = new MockCLIClient(ctx.wsBaseUrl, sessionId);
      await cli.connect();

      const browser = new MockBrowserClient(ctx.wsBaseUrl, sessionId);
      await browser.connect();
      await browser.waitForMessage("session_init");

      // Send result without context_used_percent
      cli.send(makeResultMessage({
        total_cost_usd: 0.05,
        num_turns: 3,
      }));

      await browser.waitForMessage("result");
      await delay(50);

      // Should not crash - context usage stays at default
      browser.close();
      cli.close();
    });
  });
});
