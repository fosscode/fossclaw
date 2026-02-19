import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { createTestServer, type TestContext } from "./helpers/server.js";

describe("REST API", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
  });

  // ─── Session CRUD ─────────────────────────────────────────────────

  describe("POST /api/sessions/create", () => {
    test("returns a session with sessionId and state", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessionId).toBeString();
      expect(data.state).toBe("starting");
      expect(data.cwd).toBe("/tmp");
      expect(data.provider).toBe("claude");
    });

    test("passes model and permissionMode through", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus", permissionMode: "plan" }),
      });
      const data = await res.json();
      expect(data.model).toBe("opus");
      expect(data.permissionMode).toBe("plan");
    });
  });

  describe("GET /api/sessions", () => {
    test("lists all created sessions", async () => {
      // Create 2 sessions
      await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const sessions = await res.json();
      expect(sessions).toBeArrayOfSize(2);
      expect(sessions[0].sessionId).toBeString();
      expect(sessions[1].sessionId).toBeString();
      expect(sessions[0].sessionId).not.toBe(sessions[1].sessionId);
    });
  });

  describe("GET /api/sessions/:id", () => {
    test("returns a specific session", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessionId).toBe(sessionId);
    });

    test("returns 404 for unknown ID", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/kill", () => {
    test("kills a session", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const killRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}/kill`, { method: "POST" });
      expect(killRes.status).toBe(200);
      const killData = await killRes.json();
      expect(killData.ok).toBe(true);

      // Session should now be exited
      const getRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      const session = await getRes.json();
      expect(session.state).toBe("exited");
    });
  });

  describe("DELETE /api/sessions/:id", () => {
    test("kills and removes a session", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { sessionId } = await createRes.json();

      const delRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);

      // Session should be gone
      const getRes = await ctx.authFetch(`${ctx.baseUrl}/api/sessions/${sessionId}`);
      expect(getRes.status).toBe(404);
    });
  });

  // ─── Filesystem ─────────────────────────────────────────────────

  describe("GET /api/fs/home", () => {
    test("returns home directory and cwd", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/fs/home`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.home).toBe(homedir());
      expect(data.cwd).toBe("/tmp");
    });
  });

  describe("GET /api/fs/list", () => {
    test("lists directories at /tmp", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/fs/list?path=/tmp`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.path).toBeString();
      expect(data.dirs).toBeArray();
      expect(data.home).toBe(homedir());
    });

    test("returns 400 for nonexistent path", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/fs/list?path=/nonexistent_path_12345`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Cannot read directory");
    });
  });

  // ─── Ollama Test ─────────────────────────────────────────────────

  describe("POST /api/ollama/test", () => {
    test("returns 400 when no URL provided", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/ollama/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toBeString();
    });

    test("returns ok:false when Ollama is unreachable", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/ollama/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://localhost:19999" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toBeString();
    });

    test("accepts optional model parameter", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/ollama/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://localhost:19999", model: "llama3.2:3b" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      // Still unreachable, but the request itself should be well-formed
      expect(data.ok).toBe(false);
    });
  });
});
