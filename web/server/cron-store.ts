import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CronJob, CronRun } from "./cron-types.js";

const MAX_RUNS_PER_JOB = 100;
const MAX_SEEN_KEYS = 5000;

export class CronJobStore {
  private configPath: string;
  private runsDir: string;
  private cachedJobs: CronJob[] | null = null;
  private pendingJobs: CronJob[] | null = null;
  private timer: Timer | null = null;

  constructor(baseDir?: string) {
    const base = baseDir || join(homedir(), ".fossclaw");
    this.configPath = join(base, "cron-jobs.json");
    this.runsDir = join(base, "cron-runs");
  }

  // ─── Job CRUD ────────────────────────────────────────────────

  async loadJobs(): Promise<CronJob[]> {
    if (this.cachedJobs) {
      return this.pendingJobs || this.cachedJobs;
    }
    try {
      const raw = await readFile(this.configPath, "utf-8");
      this.cachedJobs = JSON.parse(raw) as CronJob[];
    } catch {
      this.cachedJobs = [];
    }
    return this.pendingJobs || this.cachedJobs;
  }

  saveJobs(jobs: CronJob[]): void {
    this.pendingJobs = jobs;
    this.cachedJobs = jobs;
    this.debounce();
  }

  async addJob(job: CronJob): Promise<void> {
    const jobs = await this.loadJobs();
    jobs.push(job);
    this.saveJobs([...jobs]);
  }

  async updateJob(id: string, updates: Partial<CronJob>): Promise<CronJob | null> {
    const jobs = await this.loadJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return null;
    const updated = { ...jobs[idx], ...updates };
    jobs[idx] = updated;
    this.saveJobs([...jobs]);
    return updated;
  }

  async removeJob(id: string): Promise<boolean> {
    const jobs = await this.loadJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    jobs.splice(idx, 1);
    this.saveJobs([...jobs]);
    return true;
  }

  async getJob(id: string): Promise<CronJob | null> {
    const jobs = await this.loadJobs();
    return jobs.find((j) => j.id === id) ?? null;
  }

  // ─── Run history ──────────────────────────────────────────────

  private runsPath(jobId: string): string {
    return join(this.runsDir, jobId, "runs.json");
  }

  private seenKeysPath(jobId: string): string {
    return join(this.runsDir, jobId, "seen-keys.json");
  }

  async addRun(jobId: string, run: CronRun): Promise<void> {
    const runs = await this.getRuns(jobId, MAX_RUNS_PER_JOB);
    runs.unshift(run);
    // Cap at MAX_RUNS_PER_JOB
    if (runs.length > MAX_RUNS_PER_JOB) {
      runs.length = MAX_RUNS_PER_JOB;
    }
    await this.atomicWrite(this.runsPath(jobId), runs);
  }

  async getRuns(jobId: string, limit = 20): Promise<CronRun[]> {
    try {
      const raw = await readFile(this.runsPath(jobId), "utf-8");
      const runs = JSON.parse(raw) as CronRun[];
      return runs.slice(0, limit);
    } catch {
      return [];
    }
  }

  async updateRun(jobId: string, runId: string, updates: Partial<CronRun>): Promise<void> {
    const runs = await this.getRuns(jobId, MAX_RUNS_PER_JOB);
    const idx = runs.findIndex((r) => r.id === runId);
    if (idx === -1) return;
    runs[idx] = { ...runs[idx], ...updates };
    await this.atomicWrite(this.runsPath(jobId), runs);
  }

  // ─── Deduplication ────────────────────────────────────────────

  async getSeenKeys(jobId: string): Promise<Set<string>> {
    try {
      const raw = await readFile(this.seenKeysPath(jobId), "utf-8");
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  async addSeenKey(jobId: string, key: string): Promise<void> {
    const keys = await this.getSeenKeys(jobId);
    keys.add(key);
    // Cap seen keys to prevent unbounded growth
    const arr = Array.from(keys);
    if (arr.length > MAX_SEEN_KEYS) {
      arr.splice(0, arr.length - MAX_SEEN_KEYS);
    }
    await this.atomicWrite(this.seenKeysPath(jobId), arr);
  }

  async addSeenKeys(jobId: string, newKeys: string[]): Promise<void> {
    if (newKeys.length === 0) return;
    const keys = await this.getSeenKeys(jobId);
    for (const k of newKeys) keys.add(k);
    const arr = Array.from(keys);
    if (arr.length > MAX_SEEN_KEYS) {
      arr.splice(0, arr.length - MAX_SEEN_KEYS);
    }
    await this.atomicWrite(this.seenKeysPath(jobId), arr);
  }

  async clearSeenKeys(jobId: string): Promise<void> {
    await this.atomicWrite(this.seenKeysPath(jobId), []);
  }

  // ─── Flush ────────────────────────────────────────────────────

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingJobs) {
      await this.writeToDisk();
    }
  }

  // ─── Internal ─────────────────────────────────────────────────

  private debounce(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.writeToDisk(), 500);
  }

  private async writeToDisk(): Promise<void> {
    if (!this.pendingJobs) return;
    const jobs = this.pendingJobs;
    this.pendingJobs = null;
    this.cachedJobs = jobs;
    await this.atomicWrite(this.configPath, jobs);
  }

  private async atomicWrite(path: string, data: unknown): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmpPath = path + ".tmp";
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmpPath, path);
  }
}
