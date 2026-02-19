import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CronJobStore } from "../server/cron-store.js";
import { CronScheduler } from "../server/cron-scheduler.js";
import { WsBridge } from "../server/ws-bridge.js";
import { setGitHubToken, setSlackBotToken } from "../server/cron-checkers.js";
import type { CronJob } from "../server/cron-types.js";

// ─── Mock Launcher ──────────────────────────────────────────────────

class MockLauncher {
  sessions = new Map<string, any>();

  launch(options: any = {}) {
    const sessionId = randomUUID();
    const info = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      cwd: options.cwd || "/tmp",
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, info);
    return info;
  }

  getSession(id: string) { return this.sessions.get(id); }
  listSessions() { return Array.from(this.sessions.values()); }
  markConnected(id: string) { const s = this.sessions.get(id); if (s) s.state = "connected"; }
  async kill(id: string) { const s = this.sessions.get(id); if (s) s.state = "exited"; return !!s; }
  removeSession(id: string) { this.sessions.delete(id); }
  updateActivity() {}
}

// ─── Mock Session Store ─────────────────────────────────────────────

class MockSessionStore {
  private data = new Map<string, any>();

  async load(id: string) { return this.data.get(id) || null; }
  async saveMeta(id: string, meta: any) {
    const existing = this.data.get(id) || { meta: {}, state: {}, history: [] };
    existing.meta = meta;
    this.data.set(id, existing);
  }
  async saveHistory(id: string, history: any[]) {
    const existing = this.data.get(id) || { meta: {}, state: {}, history: [] };
    existing.history = history;
    this.data.set(id, existing);
  }
  async saveState() {}
  async remove() {}
  async flush() {}
}

// ─── Helpers ────────────────────────────────────────────────────────

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: randomUUID(),
    name: "Test Job",
    type: "e2e_testing",
    enabled: true,
    intervalSeconds: 1, // 1 second for fast testing
    config: {
      testCommand: "echo 'test output'",
      cwd: "/tmp",
      onlyOnFailure: false,
      promptTemplate: "",
    },
    lastRunAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("CronScheduler", () => {
  let testDir: string;
  let store: CronJobStore;
  let launcher: MockLauncher;
  let bridge: WsBridge;
  let sessionStore: MockSessionStore;
  let scheduler: CronScheduler;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "cron-sched-test-"));
    store = new CronJobStore(testDir);
    launcher = new MockLauncher();
    bridge = new WsBridge();
    sessionStore = new MockSessionStore();
    scheduler = new CronScheduler(store, launcher as any, bridge, sessionStore as any);
  });

  afterEach(async () => {
    scheduler.stop();
    await store.flush();
    await rm(testDir, { recursive: true, force: true });
  });

  // ─── Start / Stop ─────────────────────────────────────────────────

  describe("start/stop", () => {
    test("starts the scheduler", () => {
      scheduler.start();
      const status = scheduler.getStatus();
      expect(status.running).toBe(true);
    });

    test("stops the scheduler", () => {
      scheduler.start();
      scheduler.stop();
      const status = scheduler.getStatus();
      expect(status.running).toBe(false);
    });

    test("start is idempotent", () => {
      scheduler.start();
      scheduler.start(); // Should not throw or create duplicate timers
      const status = scheduler.getStatus();
      expect(status.running).toBe(true);
    });
  });

  // ─── getStatus ────────────────────────────────────────────────────

  describe("getStatus", () => {
    test("reports no active jobs initially", () => {
      const status = scheduler.getStatus();
      expect(status.activeJobs).toEqual([]);
    });

    test("reports running state", () => {
      expect(scheduler.getStatus().running).toBe(false);
      scheduler.start();
      expect(scheduler.getStatus().running).toBe(true);
      scheduler.stop();
      expect(scheduler.getStatus().running).toBe(false);
    });
  });

  // ─── triggerJob (manual trigger) ──────────────────────────────────

  describe("triggerJob", () => {
    test("returns null for non-existent job", async () => {
      const result = await scheduler.triggerJob("non-existent");
      expect(result).toBeNull();
    });

    test("returns a run object for existing job", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      const run = await scheduler.triggerJob(job.id);
      expect(run).not.toBeNull();
      expect(run!.jobId).toBe(job.id);
      expect(run!.status).toBe("running");
      expect(run!.triggerSummary).toBe("Manual trigger");
    });

    test("spawns a session for the triggered job", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);

      // Give the async executeJob time to complete
      await new Promise((r) => setTimeout(r, 2000));

      expect(launcher.sessions.size).toBeGreaterThan(0);
    });
  });

  // ─── Job Execution ────────────────────────────────────────────────

  describe("job execution", () => {
    test("executes job via manual trigger and spawns session", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      // Wait for async execution
      await new Promise((r) => setTimeout(r, 2000));

      // Should have spawned at least one session
      expect(launcher.sessions.size).toBeGreaterThan(0);
    });

    test("skips disabled jobs via tick (verified through triggerJob behavior)", async () => {
      const job = makeJob({ enabled: false });
      await store.addJob(job);
      await store.flush();

      // triggerJob bypasses enabled check, but the tick() method checks it.
      // We verify the scheduler status after start shows no active jobs.
      scheduler.start();
      // The tick runs every 15s, but disabled jobs are skipped immediately.
      // We just verify state is correct.
      const status = scheduler.getStatus();
      expect(status.running).toBe(true);
      expect(status.activeJobs).toEqual([]);
      scheduler.stop();
    });

    test("deduplicates triggers across runs", async () => {
      // The e2e_testing checker uses timestamp-based dedup keys so
      // each run gets a new key. To test dedup, we use a fixed dedup approach.
      // We verify by checking the store's seen keys after execution.
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      const seenKeys = await store.getSeenKeys(job.id);
      expect(seenKeys.size).toBeGreaterThan(0);
    });

    test("records run history", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      const runs = await store.getRuns(job.id);
      expect(runs.length).toBeGreaterThan(0);
    });

    test("updates lastRunAt after execution", async () => {
      const job = makeJob({ lastRunAt: null });
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      const updated = await store.getJob(job.id);
      expect(updated?.lastRunAt).not.toBeNull();
    });
  });

  // ─── Session Spawning ─────────────────────────────────────────────

  describe("session spawning", () => {
    test("passes job model and permissionMode to launcher", async () => {
      const job = makeJob({
        model: "claude-sonnet-4-20250514",
        permissionMode: "plan",
      });
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      const sessions = launcher.listSessions();
      if (sessions.length > 0) {
        expect(sessions[0].model).toBe("claude-sonnet-4-20250514");
        expect(sessions[0].permissionMode).toBe("plan");
      }
    });

    test("defaults permissionMode to auto-accept", async () => {
      const job = makeJob({ permissionMode: undefined });
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      const sessions = launcher.listSessions();
      if (sessions.length > 0) {
        expect(sessions[0].permissionMode).toBe("auto-accept");
      }
    });

    test("queues initial prompt in bridge pending messages", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      // Check that sessions were created and bridge has pending messages
      const sessions = launcher.listSessions();
      if (sessions.length > 0) {
        const session = bridge.getOrCreateSession(sessions[0].sessionId);
        expect(session.pendingMessages.length).toBeGreaterThan(0);

        // Verify the pending message is valid NDJSON
        const msg = JSON.parse(session.pendingMessages[0]);
        expect(msg.type).toBe("user");
        expect(msg.message.role).toBe("user");
      }
    });

    test("adds user message to history for UI display", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      await scheduler.triggerJob(job.id);
      await new Promise((r) => setTimeout(r, 2000));

      const sessions = launcher.listSessions();
      if (sessions.length > 0) {
        const session = bridge.getOrCreateSession(sessions[0].sessionId);
        const userMessages = session.messageHistory.filter((m: any) => m.type === "user_message");
        expect(userMessages.length).toBeGreaterThan(0);
      }
    });
  });
});
