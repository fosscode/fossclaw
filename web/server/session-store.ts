import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionState, BrowserIncomingMessage } from "./session-types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PersistedMeta {
  sessionId: string;
  pid?: number;
  model?: string;
  permissionMode?: string;
  provider?: string;
  cwd: string;
  createdAt: number;
  sessionName?: string;
  lastActivityAt?: number; // Last message or interaction timestamp
}

export interface PersistedSession {
  meta: PersistedMeta;
  state: SessionState;
  history: BrowserIncomingMessage[];
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface SessionStore {
  saveMeta(sessionId: string, meta: PersistedMeta): void;
  saveState(sessionId: string, state: SessionState): void;
  saveHistory(sessionId: string, history: BrowserIncomingMessage[]): void;
  load(sessionId: string): Promise<PersistedSession | null>;
  loadAll(): Promise<PersistedSession[]>;
  remove(sessionId: string): Promise<void>;
  flush(): Promise<void>;
}

// ─── FileSessionStore ────────────────────────────────────────────────────────

export class FileSessionStore implements SessionStore {
  private baseDir: string;
  private pendingMeta = new Map<string, PersistedMeta>();
  private pendingState = new Map<string, SessionState>();
  private pendingHistory = new Map<string, BrowserIncomingMessage[]>();
  private metaTimers = new Map<string, Timer>();
  private stateTimers = new Map<string, Timer>();
  private historyTimers = new Map<string, Timer>();

  constructor(baseDir?: string) {
    // Allow FOSSCLAW_SESSION_DIR to override default, enabling shared DB between instances
    this.baseDir = baseDir || process.env.FOSSCLAW_SESSION_DIR || join(homedir(), ".fossclaw", "sessions");
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, data, "utf-8");
    await rename(tmpPath, filePath);
  }

  saveMeta(sessionId: string, meta: PersistedMeta): void {
    this.pendingMeta.set(sessionId, meta);
    this.debounce(this.metaTimers, sessionId, 500, () => this.flushMeta(sessionId));
  }

  saveState(sessionId: string, state: SessionState): void {
    this.pendingState.set(sessionId, { ...state });
    this.debounce(this.stateTimers, sessionId, 500, () => this.flushState(sessionId));
  }

  saveHistory(sessionId: string, history: BrowserIncomingMessage[]): void {
    this.pendingHistory.set(sessionId, [...history]);
    this.debounce(this.historyTimers, sessionId, 1000, () => this.flushHistory(sessionId));
  }

  async load(sessionId: string): Promise<PersistedSession | null> {
    const dir = this.sessionDir(sessionId);
    try {
      const metaRaw = await readFile(join(dir, "meta.json"), "utf-8");
      const meta: PersistedMeta = JSON.parse(metaRaw);

      let state: SessionState;
      try {
        const stateRaw = await readFile(join(dir, "state.json"), "utf-8");
        state = JSON.parse(stateRaw);
      } catch {
        // state.json may not exist yet if session just started
        state = {
          session_id: sessionId,
          model: meta.model || "",
          cwd: meta.cwd || "",
          tools: [],
          permissionMode: meta.permissionMode || "default",
          claude_code_version: "",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        };
      }

      let history: BrowserIncomingMessage[] = [];
      try {
        const historyRaw = await readFile(join(dir, "history.json"), "utf-8");
        history = JSON.parse(historyRaw);
      } catch {
        // No history yet
      }

      return { meta, state, history };
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<PersistedSession[]> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const sessions: PersistedSession[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const session = await this.load(entry.name);
        if (session) sessions.push(session);
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async remove(sessionId: string): Promise<void> {
    // Cancel any pending timers
    this.cancelTimers(sessionId);
    this.pendingMeta.delete(sessionId);
    this.pendingState.delete(sessionId);
    this.pendingHistory.delete(sessionId);

    try {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  }

  async flush(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const sessionId of this.pendingMeta.keys()) {
      promises.push(this.flushMeta(sessionId));
    }
    for (const sessionId of this.pendingState.keys()) {
      promises.push(this.flushState(sessionId));
    }
    for (const sessionId of this.pendingHistory.keys()) {
      promises.push(this.flushHistory(sessionId));
    }
    await Promise.all(promises);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async flushMeta(sessionId: string): Promise<void> {
    const meta = this.pendingMeta.get(sessionId);
    if (!meta) return;
    this.pendingMeta.delete(sessionId);
    this.clearTimer(this.metaTimers, sessionId);
    await this.atomicWrite(join(this.sessionDir(sessionId), "meta.json"), JSON.stringify(meta));
  }

  private async flushState(sessionId: string): Promise<void> {
    const state = this.pendingState.get(sessionId);
    if (!state) return;
    this.pendingState.delete(sessionId);
    this.clearTimer(this.stateTimers, sessionId);
    await this.atomicWrite(join(this.sessionDir(sessionId), "state.json"), JSON.stringify(state));
  }

  private async flushHistory(sessionId: string): Promise<void> {
    const history = this.pendingHistory.get(sessionId);
    if (!history) return;
    this.pendingHistory.delete(sessionId);
    this.clearTimer(this.historyTimers, sessionId);
    await this.atomicWrite(join(this.sessionDir(sessionId), "history.json"), JSON.stringify(history));
  }

  private debounce(timers: Map<string, Timer>, sessionId: string, ms: number, fn: () => void): void {
    const existing = timers.get(sessionId);
    if (existing) clearTimeout(existing);
    timers.set(sessionId, setTimeout(fn, ms));
  }

  private clearTimer(timers: Map<string, Timer>, sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  }

  private cancelTimers(sessionId: string): void {
    this.clearTimer(this.metaTimers, sessionId);
    this.clearTimer(this.stateTimers, sessionId);
    this.clearTimer(this.historyTimers, sessionId);
  }
}

// ─── NullSessionStore ────────────────────────────────────────────────────────

export class NullSessionStore implements SessionStore {
  saveMeta(): void {}
  saveState(): void {}
  saveHistory(): void {}
  async load(): Promise<null> { return null; }
  async loadAll(): Promise<PersistedSession[]> { return []; }
  async remove(): Promise<void> {}
  async flush(): Promise<void> {}
}
