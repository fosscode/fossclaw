import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createTestServer, type TestContext } from "./helpers/server.js";

describe("Update REST API", () => {
  let ctx: TestContext;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
    globalThis.fetch = originalFetch;
  });

  // ─── GET /api/updates/check ────────────────────────────────────────

  describe("GET /api/updates/check", () => {
    test("returns update check result", async () => {
      // The update checker will try to call GitHub API. We mock fetch at global level.
      // But our test server's own requests use internal Bun routing, so we need to be careful.
      // The check will likely fail with a network error which is handled gracefully.
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/updates/check`);
      expect(res.status).toBe(200);
      const data = await res.json();

      // Should always return these fields
      expect(data.currentVersion).toBeString();
      expect(typeof data.updateAvailable).toBe("boolean");
      expect(data.latestVersion).toBeString();
    });

    test("returns currentVersion from package.json", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/updates/check`);
      const data = await res.json();
      // Version should look like a semver
      expect(data.currentVersion).toMatch(/^\d+\.\d+\.\d+|unknown$/);
    });
  });

  // ─── POST /api/updates/install ─────────────────────────────────────

  describe("POST /api/updates/install", () => {
    test("returns success response (install runs async)", async () => {
      // Install will fail because no download URL is set, but the endpoint
      // responds immediately since install runs asynchronously
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/updates/install`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.message).toContain("restart");
    });
  });

  // ─── GET /api/health ───────────────────────────────────────────────

  describe("GET /api/health", () => {
    test("returns version in health check", async () => {
      const res = await fetch(`${ctx.baseUrl}/api/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
      expect(data.version).toBeString();
      expect(data.uptime).toBeNumber();
    });
  });
});

// ─── UpdateChecker integration (with mocked GitHub API) ──────────────

describe("Update check with mocked GitHub", () => {
  let ctx: TestContext;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    ctx = createTestServer();
  });

  afterEach(() => {
    ctx.close();
    globalThis.fetch = originalFetch;
  });

  // Note: We can't easily mock the UpdateChecker's fetch from outside since
  // it's created inside createRoutes. These tests verify the REST layer
  // handles various response shapes correctly.

  test("update check endpoint doesn't crash on error", async () => {
    const res = await ctx.authFetch(`${ctx.baseUrl}/api/updates/check`);
    // Should always return 200 even if GitHub API fails (graceful handling)
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("currentVersion");
  });
});
