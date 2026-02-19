import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { CronJobStore } from "../server/cron-store.js";
import type { CronJob, CronRun } from "../server/cron-types.js";
import { randomUUID } from "node:crypto";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: randomUUID(),
    name: "Test Job",
    type: "e2e_testing",
    enabled: true,
    intervalSeconds: 300,
    config: {
      testCommand: "bun test",
      cwd: "/tmp",
      onlyOnFailure: true,
      promptTemplate: "",
    },
    lastRunAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeRun(jobId: string, overrides: Partial<CronRun> = {}): CronRun {
  return {
    id: randomUUID(),
    jobId,
    startedAt: Date.now(),
    finishedAt: Date.now() + 1000,
    status: "completed",
    sessionId: null,
    triggerSummary: "Test run",
    error: null,
    triggerCount: 1,
    ...overrides,
  };
}

describe("CronJobStore", () => {
  let testDir: string;
  let store: CronJobStore;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "cron-store-test-"));
    store = new CronJobStore(testDir);
  });

  afterEach(async () => {
    await store.flush();
    await rm(testDir, { recursive: true, force: true });
  });

  // ─── Job CRUD ─────────────────────────────────────────────────────

  describe("loadJobs", () => {
    test("returns empty array when no config file exists", async () => {
      const jobs = await store.loadJobs();
      expect(jobs).toEqual([]);
    });

    test("loads jobs from disk", async () => {
      const job = makeJob();
      await store.addJob(job);
      await store.flush();

      // Create a fresh store to force reading from disk
      const store2 = new CronJobStore(testDir);
      const jobs = await store2.loadJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].id).toBe(job.id);
      expect(jobs[0].name).toBe("Test Job");
    });
  });

  describe("addJob", () => {
    test("adds a job and persists it", async () => {
      const job = makeJob({ name: "My Cron Job" });
      await store.addJob(job);

      const jobs = await store.loadJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].name).toBe("My Cron Job");
    });

    test("adds multiple jobs", async () => {
      await store.addJob(makeJob({ name: "Job 1" }));
      await store.addJob(makeJob({ name: "Job 2" }));
      await store.addJob(makeJob({ name: "Job 3" }));

      const jobs = await store.loadJobs();
      expect(jobs.length).toBe(3);
    });
  });

  describe("updateJob", () => {
    test("updates an existing job", async () => {
      const job = makeJob({ name: "Original" });
      await store.addJob(job);

      const updated = await store.updateJob(job.id, { name: "Updated" });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated");
      expect(updated!.id).toBe(job.id);
    });

    test("returns null for non-existent job", async () => {
      const result = await store.updateJob("non-existent-id", { name: "Updated" });
      expect(result).toBeNull();
    });

    test("preserves other fields when updating", async () => {
      const job = makeJob({ name: "Original", intervalSeconds: 600 });
      await store.addJob(job);

      await store.updateJob(job.id, { name: "Updated" });

      const jobs = await store.loadJobs();
      expect(jobs[0].name).toBe("Updated");
      expect(jobs[0].intervalSeconds).toBe(600);
    });

    test("updates lastRunAt timestamp", async () => {
      const job = makeJob();
      await store.addJob(job);

      const now = Date.now();
      await store.updateJob(job.id, { lastRunAt: now });

      const jobs = await store.loadJobs();
      expect(jobs[0].lastRunAt).toBe(now);
    });
  });

  describe("removeJob", () => {
    test("removes an existing job", async () => {
      const job = makeJob();
      await store.addJob(job);
      expect(await store.loadJobs()).toHaveLength(1);

      const removed = await store.removeJob(job.id);
      expect(removed).toBe(true);

      const jobs = await store.loadJobs();
      expect(jobs).toHaveLength(0);
    });

    test("returns false for non-existent job", async () => {
      const removed = await store.removeJob("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("getJob", () => {
    test("returns a specific job by ID", async () => {
      const job = makeJob({ name: "Specific" });
      await store.addJob(job);

      const found = await store.getJob(job.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Specific");
    });

    test("returns null for unknown ID", async () => {
      const found = await store.getJob("unknown");
      expect(found).toBeNull();
    });
  });

  // ─── Run History ──────────────────────────────────────────────────

  describe("addRun / getRuns", () => {
    test("adds and retrieves a run", async () => {
      const jobId = randomUUID();
      const run = makeRun(jobId);
      await store.addRun(jobId, run);

      const runs = await store.getRuns(jobId);
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe(run.id);
    });

    test("prepends runs (newest first)", async () => {
      const jobId = randomUUID();
      const run1 = makeRun(jobId, { triggerSummary: "First" });
      const run2 = makeRun(jobId, { triggerSummary: "Second" });

      await store.addRun(jobId, run1);
      await store.addRun(jobId, run2);

      const runs = await store.getRuns(jobId);
      expect(runs.length).toBe(2);
      expect(runs[0].triggerSummary).toBe("Second");
      expect(runs[1].triggerSummary).toBe("First");
    });

    test("limits returned runs", async () => {
      const jobId = randomUUID();
      for (let i = 0; i < 10; i++) {
        await store.addRun(jobId, makeRun(jobId, { triggerSummary: `Run ${i}` }));
      }

      const runs = await store.getRuns(jobId, 3);
      expect(runs.length).toBe(3);
    });

    test("caps at MAX_RUNS_PER_JOB (100)", async () => {
      const jobId = randomUUID();
      for (let i = 0; i < 105; i++) {
        await store.addRun(jobId, makeRun(jobId));
      }

      const runs = await store.getRuns(jobId, 200);
      expect(runs.length).toBe(100);
    });

    test("returns empty array for unknown jobId", async () => {
      const runs = await store.getRuns("unknown-job");
      expect(runs).toEqual([]);
    });
  });

  describe("updateRun", () => {
    test("updates a run's status and error", async () => {
      const jobId = randomUUID();
      const run = makeRun(jobId, { status: "running", finishedAt: null });
      await store.addRun(jobId, run);

      await store.updateRun(jobId, run.id, {
        status: "failed",
        error: "Something went wrong",
        finishedAt: Date.now(),
      });

      const runs = await store.getRuns(jobId);
      expect(runs[0].status).toBe("failed");
      expect(runs[0].error).toBe("Something went wrong");
      expect(runs[0].finishedAt).not.toBeNull();
    });

    test("no-op for non-existent run", async () => {
      const jobId = randomUUID();
      await store.addRun(jobId, makeRun(jobId));

      // Should not throw
      await store.updateRun(jobId, "non-existent-run", { status: "failed" });

      const runs = await store.getRuns(jobId);
      expect(runs[0].status).toBe("completed"); // unchanged
    });
  });

  // ─── Deduplication ────────────────────────────────────────────────

  describe("dedup keys", () => {
    test("starts with empty set", async () => {
      const keys = await store.getSeenKeys("job-1");
      expect(keys.size).toBe(0);
    });

    test("adds a single key", async () => {
      await store.addSeenKey("job-1", "pr:repo:42");
      const keys = await store.getSeenKeys("job-1");
      expect(keys.has("pr:repo:42")).toBe(true);
    });

    test("adds multiple keys at once", async () => {
      await store.addSeenKeys("job-1", ["key-1", "key-2", "key-3"]);
      const keys = await store.getSeenKeys("job-1");
      expect(keys.size).toBe(3);
      expect(keys.has("key-1")).toBe(true);
      expect(keys.has("key-2")).toBe(true);
      expect(keys.has("key-3")).toBe(true);
    });

    test("deduplicates existing keys", async () => {
      await store.addSeenKey("job-1", "key-1");
      await store.addSeenKey("job-1", "key-1");
      const keys = await store.getSeenKeys("job-1");
      expect(keys.size).toBe(1);
    });

    test("clears seen keys", async () => {
      await store.addSeenKeys("job-1", ["key-1", "key-2"]);
      expect((await store.getSeenKeys("job-1")).size).toBe(2);

      await store.clearSeenKeys("job-1");
      expect((await store.getSeenKeys("job-1")).size).toBe(0);
    });

    test("caps seen keys at MAX_SEEN_KEYS (5000)", async () => {
      const keys = Array.from({ length: 5010 }, (_, i) => `key-${i}`);
      await store.addSeenKeys("job-1", keys);

      const stored = await store.getSeenKeys("job-1");
      expect(stored.size).toBe(5000);

      // The oldest keys should be dropped (splice from beginning)
      expect(stored.has("key-0")).toBe(false);
      expect(stored.has("key-10")).toBe(true);
      expect(stored.has("key-5009")).toBe(true);
    });

    test("skips empty keys array", async () => {
      await store.addSeenKeys("job-1", []);
      const keys = await store.getSeenKeys("job-1");
      expect(keys.size).toBe(0);
    });

    test("keeps keys separate per job", async () => {
      await store.addSeenKey("job-1", "shared-key");
      await store.addSeenKey("job-2", "other-key");

      const keys1 = await store.getSeenKeys("job-1");
      const keys2 = await store.getSeenKeys("job-2");

      expect(keys1.has("shared-key")).toBe(true);
      expect(keys1.has("other-key")).toBe(false);
      expect(keys2.has("other-key")).toBe(true);
      expect(keys2.has("shared-key")).toBe(false);
    });
  });

  // ─── Flush & Persistence ─────────────────────────────────────────

  describe("flush", () => {
    test("flushes pending writes immediately", async () => {
      const job = makeJob({ name: "Flushed" });
      await store.addJob(job);

      // Flush to write immediately
      await store.flush();

      // Verify file exists and is valid JSON
      const configPath = join(testDir, "cron-jobs.json");
      expect(existsSync(configPath)).toBe(true);

      const raw = await readFile(configPath, "utf-8");
      const data = JSON.parse(raw);
      expect(data.length).toBe(1);
      expect(data[0].name).toBe("Flushed");
    });

    test("no-op when nothing is pending", async () => {
      // Should not throw
      await store.flush();
    });
  });

  describe("atomic writes", () => {
    test("writes produce valid JSON", async () => {
      await store.addJob(makeJob({ name: "Atomic Test" }));
      await store.flush();

      const raw = await readFile(join(testDir, "cron-jobs.json"), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    test("creates parent directories as needed", async () => {
      const deepDir = join(testDir, "deep", "nested", "path");
      const deepStore = new CronJobStore(deepDir);
      await deepStore.addJob(makeJob());
      await deepStore.flush();

      expect(existsSync(join(deepDir, "cron-jobs.json"))).toBe(true);
    });
  });

  // ─── Caching Behavior ────────────────────────────────────────────

  describe("caching", () => {
    test("loadJobs returns cached results on second call", async () => {
      const job = makeJob();
      await store.addJob(job);

      const first = await store.loadJobs();
      const second = await store.loadJobs();

      // Should be the same reference (cached)
      expect(first).toBe(second);
    });

    test("saveJobs updates cache immediately", async () => {
      const job1 = makeJob({ name: "Before" });
      await store.addJob(job1);

      const updated = makeJob({ name: "After" });
      store.saveJobs([updated]);

      const jobs = await store.loadJobs();
      expect(jobs.length).toBe(1);
      expect(jobs[0].name).toBe("After");
    });
  });
});
