import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { OpenCodeBridge } from "./opencode-bridge.js";
import type { SessionStore } from "./session-store.js";

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  provider?: "claude" | "opencode";
  cwd: string;
  createdAt: number;
  sessionName?: string;
  archived?: boolean; // Session restored from disk but CLI is dead (read-only)
  lastActivityAt?: number; // Last message or interaction timestamp
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  provider?: "claude" | "opencode";
  providerID?: string; // OpenCode provider ID (e.g., "anthropic", "google")
  cwd?: string;
  claudeBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  resumeSessionId?: string; // Session ID to resume with --resume
}

/**
 * Manages Claude Code CLI processes launched with --sdk-url.
 * Each session spawns a CLI that connects back to our WebSocket server.
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  private port: number;
  private defaultCwd: string;
  private opencodeBridge: OpenCodeBridge | null = null;
  private store: SessionStore | null;
  private useHttps: boolean;

  constructor(port: number, defaultCwd?: string, store?: SessionStore, useHttps?: boolean) {
    this.port = port;
    this.defaultCwd = defaultCwd || process.cwd();
    this.store = store ?? null;
    this.useHttps = useHttps ?? false;
  }

  setOpenCodeBridge(bridge: OpenCodeBridge) {
    this.opencodeBridge = bridge;
  }

  /**
   * Launch a new Claude Code CLI session.
   * The CLI will connect back to ws://localhost:{port}/ws/cli/{sessionId}
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const cwd = options.cwd || this.defaultCwd;

    // OpenCode sessions — delegate to the bridge
    if (options.provider === "opencode" && this.opencodeBridge) {
      const info: SdkSessionInfo = {
        sessionId,
        state: "starting",
        model: options.model,
        provider: "opencode",
        cwd,
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, info);
      this.persistMeta(info);

      // Create OpenCode session asynchronously
      this.opencodeBridge.createSession(sessionId, cwd, options.model, options.providerID)
        .then(() => {
          info.state = "connected";
          console.log(`[cli-launcher] OpenCode session ${sessionId} ready`);
        })
        .catch((err) => {
          console.error(`[cli-launcher] OpenCode session ${sessionId} failed:`, err);
          info.state = "exited";
          info.exitCode = -1;
        });

      return info;
    }

    let binary = options.claudeBinary || "claude";
    if (!binary.startsWith("/")) {
      // Try which first
      try {
        binary = execSync(`which ${binary}`, { encoding: "utf-8" }).trim();
      } catch {
        // Search common locations
        const found = this.findClaudeBinary();
        if (found) {
          binary = found;
        }
        // else fall through, hope it's in PATH
      }
    }

    const wsProto = this.useHttps ? "wss" : "ws";
    const sdkUrl = `${wsProto}://localhost:${this.port}/ws/cli/${sessionId}`;

    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // -p "" is required for headless mode, but ignored when --sdk-url is used
    args.push("-p", "");

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      provider: "claude",
      cwd,
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, info);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(this.useHttps && { NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
      ...options.env,
    };

    // Unset CLAUDECODE to allow nested sessions
    delete env.CLAUDECODE;

    console.log(`[cli-launcher] Spawning session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);
    this.persistMeta(info);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
        this.persistMeta(session);
      }
      this.processes.delete(sessionId);
    });

    return info;
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state === "starting") {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionId} connected via WebSocket`);
      this.persistMeta(session);
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
    }
    this.processes.delete(sessionId);
    return true;
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
  }

  /**
   * Restore a session from persisted data (used during startup recovery).
   * Adds the session to the internal map without spawning a process.
   */
  restoreSession(info: SdkSessionInfo): void {
    this.sessions.set(info.sessionId, info);
  }

  /**
   * Check if a session has a live subprocess (vs restored/orphaned).
   */
  hasProcess(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  private persistMeta(info: SdkSessionInfo): void {
    this.store?.saveMeta(info.sessionId, {
      sessionId: info.sessionId,
      pid: info.pid,
      model: info.model,
      permissionMode: info.permissionMode,
      provider: info.provider,
      cwd: info.cwd,
      createdAt: info.createdAt,
    });
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.sessions.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /**
   * Find claude binary in common installation locations
   */
  private findClaudeBinary(): string | null {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";

    // Common locations to check (in order of preference)
    const searchPaths = [
      `${homeDir}/bin/claude`,
      `/opt/homebrew/bin/claude`,
      `/usr/local/bin/claude`,
    ];

    // Check each path
    for (const path of searchPaths) {
      try {
        if (existsSync(path)) {
          console.log(`[cli-launcher] Found claude at ${path}`);
          return path;
        }
      } catch {
        // continue searching
      }
    }

    // Search for claude in Cursor/VSCode extensions
    try {
      const extensionDirs = [
        `${homeDir}/.cursor-server/extensions`,
        `${homeDir}/.vscode-server/extensions`,
        `${homeDir}/.local/share/code-server/extensions`,
      ];

      for (const extDir of extensionDirs) {
        if (!existsSync(extDir)) continue;

        const dirs = readdirSync(extDir);
        const claudeDirs = dirs
          .filter(d => d.startsWith("anthropic.claude-code-"))
          .sort()
          .reverse(); // Get latest version first

        for (const dir of claudeDirs) {
          const claudePath = `${extDir}/${dir}/resources/native-binary/claude`;
          if (existsSync(claudePath)) {
            console.log(`[cli-launcher] Found claude at ${claudePath}`);
            return claudePath;
          }
        }
      }
    } catch (err) {
      console.error(`[cli-launcher] Error searching for claude:`, err);
    }

    return null;
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
