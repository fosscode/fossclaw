import { randomUUID } from "node:crypto";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { CronJobStore } from "./cron-store.js";
import type { CronJob, CronRun, CheckerTrigger } from "./cron-types.js";
import { runChecker } from "./cron-checkers.js";

export class CronScheduler {
  private store: CronJobStore;
  private launcher: CliLauncher;
  private bridge: WsBridge;
  private sessionStore: SessionStore;
  private timer: Timer | null = null;
  private running = false;

  /** Track which jobs are currently executing (prevent overlapping runs) */
  private activeJobs = new Set<string>();

  /** Minimum tick interval: 15 seconds */
  private readonly TICK_INTERVAL = 15_000;

  constructor(
    store: CronJobStore,
    launcher: CliLauncher,
    bridge: WsBridge,
    sessionStore: SessionStore,
  ) {
    this.store = store;
    this.launcher = launcher;
    this.bridge = bridge;
    this.sessionStore = sessionStore;
  }

  /** Start the scheduler loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.TICK_INTERVAL);
    console.log(`[cron] Scheduler started (tick every ${this.TICK_INTERVAL / 1000}s)`);
  }

  /** Stop the scheduler loop */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[cron] Scheduler stopped");
  }

  /** Single tick: check all enabled jobs, run those whose interval has elapsed */
  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const jobs = await this.store.loadJobs();
      const now = Date.now();

      for (const job of jobs) {
        if (!job.enabled) continue;
        if (this.activeJobs.has(job.id)) continue;

        const elapsed = job.lastRunAt ? now - job.lastRunAt : Infinity;
        if (elapsed < job.intervalSeconds * 1000) continue;

        // Execute job asynchronously (don't block tick for other jobs)
        this.executeJob(job).catch((err) => {
          console.error(`[cron] Unexpected error executing job ${job.name}:`, err);
        });
      }
    } catch (err) {
      console.error("[cron] Tick error:", err);
    }
  }

  /** Execute a single job: run checker, spawn sessions for triggers */
  private async executeJob(job: CronJob): Promise<void> {
    this.activeJobs.add(job.id);

    const run: CronRun = {
      id: randomUUID(),
      jobId: job.id,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      sessionId: null,
      triggerSummary: "",
      error: null,
      triggerCount: 0,
    };

    await this.store.addRun(job.id, run);

    try {
      console.log(`[cron] Running job "${job.name}" (${job.type})`);
      const result = await runChecker(job);

      if (result.error) {
        console.warn(`[cron] Job "${job.name}" checker error: ${result.error}`);
        run.status = "failed";
        run.error = result.error;
        run.finishedAt = Date.now();
        await this.store.updateRun(job.id, run.id, run);
        await this.store.updateJob(job.id, { lastRunAt: Date.now() });
        this.activeJobs.delete(job.id);
        return;
      }

      // Deduplicate triggers against seen keys
      const seenKeys = await this.store.getSeenKeys(job.id);
      const newTriggers = result.triggers.filter((t) => !seenKeys.has(t.dedupeKey));

      if (newTriggers.length === 0) {
        run.status = "completed";
        run.triggerCount = 0;
        run.triggerSummary = "No new triggers found";
        run.finishedAt = Date.now();
        await this.store.updateRun(job.id, run.id, run);
        await this.store.updateJob(job.id, { lastRunAt: Date.now() });
        this.activeJobs.delete(job.id);
        return;
      }

      console.log(`[cron] Job "${job.name}" found ${newTriggers.length} new trigger(s)`);

      // Spawn sessions for each trigger
      const sessionIds: string[] = [];
      const summaries: string[] = [];
      const newDedupeKeys: string[] = [];

      for (const trigger of newTriggers) {
        try {
          const sessionId = await this.spawnSession(job, trigger);
          sessionIds.push(sessionId);
          summaries.push(trigger.summary);
          newDedupeKeys.push(trigger.dedupeKey);
          console.log(`[cron] Spawned session ${sessionId} for: ${trigger.summary}`);
        } catch (err) {
          console.error(`[cron] Failed to spawn session for trigger "${trigger.summary}":`, err);
          summaries.push(`FAILED: ${trigger.summary}`);
        }
      }

      // Mark dedupe keys as seen
      await this.store.addSeenKeys(job.id, newDedupeKeys);

      run.status = "completed";
      run.triggerCount = newTriggers.length;
      run.triggerSummary = summaries.join("; ");
      run.sessionId = sessionIds[0] || null; // First session as primary
      run.finishedAt = Date.now();
      await this.store.updateRun(job.id, run.id, run);
      await this.store.updateJob(job.id, { lastRunAt: Date.now() });
    } catch (err) {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = Date.now();
      await this.store.updateRun(job.id, run.id, run);
      await this.store.updateJob(job.id, { lastRunAt: Date.now() });
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  /** Spawn a Claude session for a trigger */
  private async spawnSession(job: CronJob, trigger: CheckerTrigger): Promise<string> {
    const cwd = trigger.cwd || (job.config as { cwd?: string }).cwd || process.cwd();

    const sessionInfo = this.launcher.launch({
      model: job.model,
      permissionMode: job.permissionMode || "auto-accept",
      cwd,
    });

    // Set session name
    sessionInfo.sessionName = trigger.sessionName;

    // Persist the session name
    const persisted = await this.sessionStore.load(sessionInfo.sessionId);
    if (persisted) {
      await this.sessionStore.saveMeta(sessionInfo.sessionId, {
        ...persisted.meta,
        sessionName: trigger.sessionName,
      });
    }

    // Queue the initial prompt via WsBridge pendingMessages
    // This uses the same NDJSON format as ws-bridge.ts handleUserMessage (line 670-675)
    const session = this.bridge.getOrCreateSession(sessionInfo.sessionId);
    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content: trigger.prompt },
      parent_tool_use_id: null,
      session_id: sessionInfo.sessionId,
    });
    session.pendingMessages.push(ndjson);

    // Also store in message history so it shows up in the UI
    session.messageHistory.push({
      type: "user_message",
      content: trigger.prompt,
      timestamp: Date.now(),
    });
    this.sessionStore.saveHistory(sessionInfo.sessionId, session.messageHistory);

    return sessionInfo.sessionId;
  }

  /** Manually trigger a job (from API), ignoring interval check */
  async triggerJob(jobId: string): Promise<CronRun | null> {
    const job = await this.store.getJob(jobId);
    if (!job) return null;

    // Run immediately without waiting for tick
    const run: CronRun = {
      id: randomUUID(),
      jobId: job.id,
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      sessionId: null,
      triggerSummary: "Manual trigger",
      error: null,
      triggerCount: 0,
    };

    // Execute in background
    this.executeJob(job).catch((err) => {
      console.error(`[cron] Manual trigger failed for job ${job.name}:`, err);
    });

    return run;
  }

  /** Get scheduler status */
  getStatus(): { running: boolean; activeJobs: string[] } {
    return {
      running: this.running,
      activeJobs: Array.from(this.activeJobs),
    };
  }
}
