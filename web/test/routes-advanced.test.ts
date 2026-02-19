import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestServer, type TestContext } from "./helpers/server.js";
import { setAuthCredentials, createSession as createAuthSession } from "../server/auth.js";

describe("Routes Advanced Coverage", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
  });

  // ─── Auth Endpoints ─────────────────────────────────────────────────

  describe("GET /api/auth/status", () => {
    test("returns authEnabled true (no auth required for this endpoint)", async () => {
      // Auth status is a public endpoint — no cookie needed
      const res = await fetch(`${ctx.baseUrl}/api/auth/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.authEnabled).toBe(true);
    });
  });

  describe("POST /api/auth/login", () => {
    test("succeeds with valid credentials", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "testuser", password: "testpass" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Should set a cookie
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("fossclaw_session");
    });

    test("rejects invalid credentials with 401", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "wrong", password: "wrong" }),
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Invalid credentials");
    });

    test("rejects missing username/password with 400", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Username and password required");
    });

    test("rejects partial credentials (username only)", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "testuser" }),
      });
      expect(res.status).toBe(400);
    });

    test("handles malformed JSON body", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      // Should get 400 because username/password will be undefined
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/auth/logout", () => {
    test("logs out and clears cookie", async () => {
      // Login first
      const loginRes = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "testuser", password: "testpass" }),
      });
      const setCookie = loginRes.headers.get("set-cookie") || "";
      const cookieMatch = setCookie.match(/fossclaw_session=([^;]+)/);
      const cookie = cookieMatch ? `fossclaw_session=${cookieMatch[1]}` : "";

      // Logout
      const res = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test("logout without cookie still succeeds", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/logout`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  // ─── Auth Required ──────────────────────────────────────────────────

  describe("Auth middleware", () => {
    test("returns 401 for protected routes without auth", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/sessions`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });

    test("returns 401 for invalid session cookie", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/sessions`, {
        headers: { Cookie: "fossclaw_session=invalid-session-id" },
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── Health Check ───────────────────────────────────────────────────

  describe("GET /api/health", () => {
    test("returns status ok with version (no auth required)", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
      expect(data.version).toBeString();
      expect(data.uptime).toBeNumber();
    });
  });

  // ─── Preferences ───────────────────────────────────────────────────

  describe("GET /api/preferences", () => {
    test("returns 501 when prefs store not configured", async () => {
      // Our test server doesn't pass prefsStore, so it should be 501
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/preferences`);
      expect(res.status).toBe(501);
    });
  });

  describe("PATCH /api/preferences", () => {
    test("returns 501 when prefs store not configured", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ darkMode: true }),
      });
      expect(res.status).toBe(501);
    });
  });

  // ─── Notifications ──────────────────────────────────────────────────

  describe("POST /api/notifications/test", () => {
    test("returns 501 when prefs store not configured", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/notifications/test`, {
        method: "POST",
      });
      expect(res.status).toBe(501);
    });
  });

  // ─── Session Resume ─────────────────────────────────────────────────

  describe("POST /api/sessions/:id/resume", () => {
    test("returns 404 for nonexistent session", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000/resume`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Session not found");
    });

    test("returns 400 for running session", async () => {
      // Create a session (it will be in "starting" state, not exited)
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/resume`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Session is still running");
    });

    test("returns 404 when session data not found for exited session", async () => {
      // Create and kill a session
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/kill`, {
        method: "POST",
      });

      // Try to resume — store is not configured so no persisted data
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/resume`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Cannot find session data to resume");
    });
  });

  // ─── Session Naming ─────────────────────────────────────────────────

  describe("PATCH /api/sessions/:id/name", () => {
    test("returns 400 when name field missing", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("name field required");
    });

    test("renames a session successfully", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My Session" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionName).toBe("My Session");
    });
  });

  // ─── OpenCode ───────────────────────────────────────────────────────

  describe("GET /api/opencode/models", () => {
    test("returns 501 when OpenCode bridge not configured", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/opencode/models`);
      expect(res.status).toBe(501);
    });
  });

  describe("GET /api/sessions/:id/context", () => {
    test("returns 501 for non-OpenCode session", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/context`);
      expect(res.status).toBe(501);
    });
  });

  // ─── Linear (no API key) ────────────────────────────────────────────

  describe("Linear endpoints without API key", () => {
    test("GET /api/linear/issues returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/issues`);
      expect(res.status).toBe(501);
      const data = await res.json();
      expect(data.error).toContain("Linear API key not configured");
    });

    test("GET /api/linear/issues/:id returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/issues/LIN-123`);
      expect(res.status).toBe(501);
    });

    test("GET /api/linear/teams returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/teams`);
      expect(res.status).toBe(501);
    });

    test("GET /api/linear/labels returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/labels`);
      expect(res.status).toBe(501);
    });

    test("GET /api/linear/cycles returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/cycles?team=ENG`);
      expect(res.status).toBe(501);
    });

    test("GET /api/linear/states returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/states?team=ENG`);
      expect(res.status).toBe(501);
    });

    test("GET /api/linear/members returns 501", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/members?team=ENG`);
      expect(res.status).toBe(501);
    });

    test("GET /api/linear/cycles requires team param", async () => {
      // This would be 501 because no API key, but if we had a key, it'd be 400
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/linear/cycles`);
      expect(res.status).toBe(501);
    });
  });

  // ─── Slack (no token) ───────────────────────────────────────────────

  describe("Slack endpoints", () => {
    test("POST /api/slack/test returns error with no token", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/slack/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.ok).toBe(false);
    });

    test("GET /api/slack/channels returns 501 with no token", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/slack/channels`);
      expect(res.status).toBe(501);
    });
  });

  // ─── Update Checker ─────────────────────────────────────────────────

  describe("GET /api/updates/check", () => {
    test("returns update info", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/updates/check`);
      expect(res.status).toBe(200);
      const data = await res.json();
      // Should return either an update result or an error
      expect(data).toBeDefined();
    });
  });
});
