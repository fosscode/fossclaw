import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRoutes } from "../server/routes.js";
import { WsBridge, type SocketData } from "../server/ws-bridge.js";
import { setAuthCredentials, createSession } from "../server/auth.js";
import { CronJobStore } from "../server/cron-store.js";
import { CronScheduler } from "../server/cron-scheduler.js";
import { MockCliLauncher } from "./helpers/server.js";
import type { ServerWebSocket } from "bun";

// ─── Mock Session Store ─────────────────────────────────────────────

class MockSessionStore {
  private data = new Map<string, any>();
  async load(id: string) { return this.data.get(id) || null; }
  async saveMeta(id: string, meta: any) {
    this.data.set(id, { meta, state: {}, history: [] });
  }
  async saveHistory(id: string, history: any[]) {
    const e = this.data.get(id) || { meta: {}, state: {}, history: [] };
    e.history = history;
    this.data.set(id, e);
  }
  async saveState() {}
  async remove() {}
  async flush() {}
}

interface CronTestContext {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  baseUrl: string;
  cronStore: CronJobStore;
  cronScheduler: CronScheduler;
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
}

function createCronTestServer(): CronTestContext {
  setAuthCredentials("testuser", "testpass");

  const bridge = new WsBridge();
  const launcher = new MockCliLauncher();
  const sessionStore = new MockSessionStore();
  const cronStore = new CronJobStore(join(tmpdir(), `cron-api-test-${randomUUID()}`));
  const cronScheduler = new CronScheduler(cronStore, launcher as any, bridge, sessionStore as any);

  const app = new Hono();
  app.use("/api/*", cors());
  app.route(
    "/api",
    createRoutes(
      launcher as any,
      bridge,
      "/tmp",
      undefined, // opencodeBridge
      undefined, // store
      undefined, // prefsStore
      cronStore,
      cronScheduler,
    ),
  );

  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(req, server) {
      return app.fetch(req, server);
    },
    websocket: {
      open() {},
      message() {},
      close() {},
    },
  });

  const port = server.port;
  const sessionId = createSession("testuser");
  const authCookie = `fossclaw_session=${sessionId}`;

  const authFetch = (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", authCookie);
    return fetch(url, { ...init, headers });
  };

  return {
    server,
    port,
    baseUrl: `http://localhost:${port}`,
    cronStore,
    cronScheduler,
    authFetch,
    close: () => {
      cronScheduler.stop();
      server.stop(true);
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Cron REST API", () => {
  let ctx: CronTestContext;

  beforeEach(() => {
    ctx = createCronTestServer();
  });

  afterEach(async () => {
    ctx.close();
    await ctx.cronStore.flush();
  });

  // ─── GET /api/cron/jobs ────────────────────────────────────────────

  describe("GET /api/cron/jobs", () => {
    test("returns empty jobs list initially", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.jobs).toEqual([]);
    });

    test("returns created jobs", async () => {
      // Create a job first
      await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Job",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`);
      const data = await res.json();
      expect(data.jobs.length).toBe(1);
      expect(data.jobs[0].name).toBe("Test Job");
    });
  });

  // ─── POST /api/cron/jobs ───────────────────────────────────────────

  describe("POST /api/cron/jobs", () => {
    test("creates a new cron job", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "PR Review Bot",
          type: "pr_review",
          intervalSeconds: 600,
          config: {
            repos: ["fosscode/fossclaw"],
            filterLabels: [],
            ignoreLabels: ["wip"],
            ignoreDrafts: true,
            cwd: "/home/user/project",
            promptTemplate: "",
          },
        }),
      });

      expect(res.status).toBe(201);
      const job = await res.json();
      expect(job.id).toBeString();
      expect(job.name).toBe("PR Review Bot");
      expect(job.type).toBe("pr_review");
      expect(job.intervalSeconds).toBe(600);
      expect(job.enabled).toBe(false); // Default disabled
      expect(job.lastRunAt).toBeNull();
      expect(job.createdAt).toBeNumber();
    });

    test("returns 400 when name is missing", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "e2e_testing", config: {} }),
      });
      expect(res.status).toBe(400);
    });

    test("returns 400 when type is missing", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", config: {} }),
      });
      expect(res.status).toBe(400);
    });

    test("returns 400 when config is missing", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", type: "e2e_testing" }),
      });
      expect(res.status).toBe(400);
    });

    test("accepts optional model and permissionMode", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Job with Model",
          type: "e2e_testing",
          model: "claude-sonnet-4-20250514",
          permissionMode: "plan",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });

      expect(res.status).toBe(201);
      const job = await res.json();
      expect(job.model).toBe("claude-sonnet-4-20250514");
      expect(job.permissionMode).toBe("plan");
    });

    test("defaults intervalSeconds to 300", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Default Interval",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });

      const job = await res.json();
      expect(job.intervalSeconds).toBe(300);
    });
  });

  // ─── GET /api/cron/jobs/:id ────────────────────────────────────────

  describe("GET /api/cron/jobs/:id", () => {
    test("returns a specific job", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Specific Job",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}`);
      expect(res.status).toBe(200);
      const job = await res.json();
      expect(job.name).toBe("Specific Job");
    });

    test("returns 404 for unknown job", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${randomUUID()}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /api/cron/jobs/:id ──────────────────────────────────────

  describe("PATCH /api/cron/jobs/:id", () => {
    test("updates job fields", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Original",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name", intervalSeconds: 900 }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.name).toBe("Updated Name");
      expect(updated.intervalSeconds).toBe(900);
    });

    test("sets updatedAt on update", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Job",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const created = await createRes.json();

      await new Promise((r) => setTimeout(r, 10));

      const updateRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });
      const updated = await updateRes.json();
      expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    });

    test("returns 404 for unknown job", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${randomUUID()}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No Job" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /api/cron/jobs/:id ─────────────────────────────────────

  describe("DELETE /api/cron/jobs/:id", () => {
    test("deletes a job", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "To Delete",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      const delRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);
      const data = await delRes.json();
      expect(data.ok).toBe(true);

      // Verify it's gone
      const getRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for unknown job", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${randomUUID()}`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/cron/jobs/:id/toggle ────────────────────────────────

  describe("POST /api/cron/jobs/:id/toggle", () => {
    test("toggles job enabled state", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Toggle Test",
          type: "e2e_testing",
          enabled: false,
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const created = await createRes.json();
      expect(created.enabled).toBe(false);

      // Toggle on
      const toggle1 = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}/toggle`, { method: "POST" });
      const toggled1 = await toggle1.json();
      expect(toggled1.enabled).toBe(true);

      // Toggle off
      const toggle2 = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}/toggle`, { method: "POST" });
      const toggled2 = await toggle2.json();
      expect(toggled2.enabled).toBe(false);
    });

    test("returns 404 for unknown job", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${randomUUID()}/toggle`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/cron/jobs/:id/trigger ───────────────────────────────

  describe("POST /api/cron/jobs/:id/trigger", () => {
    test("triggers a job manually", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Manual Trigger",
          type: "e2e_testing",
          config: { testCommand: "echo triggered", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}/trigger`, { method: "POST" });
      expect(res.status).toBe(200);
      const run = await res.json();
      expect(run.jobId).toBe(id);
      expect(run.status).toBe("running");
    });

    test("returns 404 for unknown job", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${randomUUID()}/trigger`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/cron/jobs/:id/runs ───────────────────────────────────

  describe("GET /api/cron/jobs/:id/runs", () => {
    test("returns empty runs initially", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Runs Test",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}/runs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runs).toEqual([]);
    });

    test("respects limit parameter", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Limit Test",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}/runs?limit=5`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.runs).toBeArray();
    });
  });

  // ─── POST /api/cron/jobs/:id/reset ─────────────────────────────────

  describe("POST /api/cron/jobs/:id/reset", () => {
    test("clears dedup keys for a job", async () => {
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Reset Test",
          type: "e2e_testing",
          config: { testCommand: "echo test", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      const { id } = await createRes.json();

      // Add some seen keys
      await ctx.cronStore.addSeenKeys(id, ["key1", "key2", "key3"]);
      expect((await ctx.cronStore.getSeenKeys(id)).size).toBe(3);

      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${id}/reset`, { method: "POST" });
      expect(res.status).toBe(200);

      // Verify keys were cleared
      expect((await ctx.cronStore.getSeenKeys(id)).size).toBe(0);
    });
  });

  // ─── GET /api/cron/status ──────────────────────────────────────────

  describe("GET /api/cron/status", () => {
    test("returns scheduler status", async () => {
      const res = await ctx.authFetch(`${ctx.baseUrl}/api/cron/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.running).toBe(false);
      expect(data.activeJobs).toEqual([]);
    });
  });

  // ─── Full CRUD lifecycle ───────────────────────────────────────────

  describe("full CRUD lifecycle", () => {
    test("create → read → update → toggle → trigger → runs → delete", async () => {
      // Create
      const createRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Lifecycle Job",
          type: "e2e_testing",
          config: { testCommand: "echo lifecycle", cwd: "/tmp", onlyOnFailure: false, promptTemplate: "" },
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      // Read
      const getRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}`);
      expect(getRes.status).toBe(200);
      expect((await getRes.json()).name).toBe("Lifecycle Job");

      // Update
      const patchRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Lifecycle" }),
      });
      expect((await patchRes.json()).name).toBe("Updated Lifecycle");

      // Toggle
      const toggleRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}/toggle`, { method: "POST" });
      expect((await toggleRes.json()).enabled).toBe(true);

      // Trigger
      const triggerRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}/trigger`, { method: "POST" });
      expect(triggerRes.status).toBe(200);

      // List all jobs
      const listRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`);
      expect((await listRes.json()).jobs.length).toBe(1);

      // Delete
      const delRes = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs/${created.id}`, { method: "DELETE" });
      expect(delRes.status).toBe(200);

      // Verify deleted
      const finalList = await ctx.authFetch(`${ctx.baseUrl}/api/cron/jobs`);
      expect((await finalList.json()).jobs.length).toBe(0);
    });
  });
});
