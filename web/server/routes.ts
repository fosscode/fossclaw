import { Hono } from "hono";
import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { OpenCodeBridge } from "./opencode-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { UserPreferencesStore } from "./user-preferences.js";
import * as linear from "./linear-client.js";
import { requireAuth, validateCredentials, createSession, deleteSession, setAuthCookie, clearAuthCookie, isAuthEnabled } from "./auth.js";
import { UpdateChecker } from "./update-checker.js";
import { readFileSync } from "node:fs";

export function createRoutes(launcher: CliLauncher, wsBridge: WsBridge, defaultCwd?: string, opencodeBridge?: OpenCodeBridge, store?: SessionStore, prefsStore?: UserPreferencesStore) {
  const api = new Hono();

  // Read version from package.json
  let currentVersion = "unknown";
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, "../package.json"), "utf-8")
    );
    currentVersion = packageJson.version;
  } catch {
    // Fallback to env variable if package.json not found
    currentVersion = process.env.npm_package_version || "unknown";
  }

  const updateChecker = new UpdateChecker(currentVersion);

  // ─── Authentication ─────────────────────────────────────

  api.get("/auth/status", (c) => {
    return c.json({ authEnabled: isAuthEnabled() });
  });

  api.post("/auth/login", async (c) => {
    if (!isAuthEnabled()) {
      return c.json({ error: "Authentication not configured" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { username, password } = body;

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    if (!validateCredentials(username, password)) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const sessionId = createSession(username);
    setAuthCookie(c, sessionId);

    return c.json({ success: true });
  });

  api.post("/auth/logout", (c) => {
    const sessionId = c.req.header("Cookie")?.match(/fossclaw_session=([^;]+)/)?.[1];
    deleteSession(sessionId);
    clearAuthCookie(c);
    return c.json({ success: true });
  });

  // ─── Protected Routes ─────────────────────────────────────

  // ─── Health Check (public, no auth) ─────────────────────────────────────

  api.get("/health", (c) => {
    return c.json({
      status: "ok",
      version: currentVersion,
      uptime: process.uptime(),
    });
  });

  // ─── Update Checker ─────────────────────────────────────

  api.get("/updates/check", async (c) => {
    try {
      const result = await updateChecker.checkForUpdates();
      return c.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/updates/install", async (c) => {
    try {
      // Start the update process (will shutdown the server)
      updateChecker.downloadAndInstall().catch((err) => {
        console.error("[updater] Install failed:", err);
      });
      return c.json({ success: true, message: "Update started, server will restart" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Protected Routes ─────────────────────────────────────

  // Apply auth middleware to all routes below
  api.use("/*", requireAuth);

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const session = launcher.launch({
        model: body.model,
        permissionMode: body.permissionMode,
        provider: body.provider,
        providerID: body.providerID,
        cwd: body.cwd,
        claudeBinary: body.claudeBinary,
        allowedTools: body.allowedTools,
        env: body.env,
      });
      if (body.sessionName) {
        session.sessionName = body.sessionName;
      }
      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/sessions", (c) => {
    return c.json(launcher.listSessions());
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    const killed = await launcher.kill(id);
    if (!killed) return c.json({ error: "Session not found or already exited" }, 404);
    return c.json({ ok: true });
  });

  api.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    await launcher.kill(id);
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    await store?.remove(id);
    return c.json({ ok: true });
  });

  api.patch("/sessions/:id/name", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const name = body.name;
    if (typeof name !== "string") {
      return c.json({ error: "name field required" }, 400);
    }

    // Load existing meta and update sessionName
    const session = await store?.load(id);
    if (session) {
      store?.saveMeta(id, { ...session.meta, sessionName: name });
    }

    // Also update launcher session if store not available
    const launcherSession = launcher.getSession(id);
    if (launcherSession) {
      launcherSession.sessionName = name;
    }

    return c.json({ ok: true, sessionName: name });
  });

  api.post("/sessions/:id/resume", async (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    if (session.state !== "exited" && !session.archived) {
      return c.json({ error: "Session is still running" }, 400);
    }

    // Load persisted session to get the original session ID from Claude CLI
    const persisted = await store?.load(id);
    if (!persisted) {
      return c.json({ error: "Cannot find session data to resume" }, 404);
    }

    // The resumeSessionId should be the session_id from the persisted state
    const resumeSessionId = persisted.state.session_id;
    if (!resumeSessionId) {
      return c.json({ error: "Cannot find Claude session ID to resume" }, 404);
    }

    try {
      // Launch a new CLI process that resumes the old session
      const newSession = launcher.launch({
        model: session.model,
        permissionMode: session.permissionMode,
        cwd: session.cwd,
        resumeSessionId,
      });

      // Copy over session metadata
      if (persisted.meta.sessionName) {
        store?.saveMeta(newSession.sessionId, {
          ...persisted.meta,
          sessionId: newSession.sessionId,
          pid: newSession.pid,
          lastActivityAt: Date.now(),
        });
      }

      // Remove the old archived session from our tracking
      launcher.removeSession(id);
      wsBridge.closeSession(id);

      return c.json({
        ok: true,
        newSessionId: newSession.sessionId,
        oldSessionId: id,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to resume session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── User Preferences ─────────────────────────────────────

  api.get("/preferences", async (c) => {
    if (!prefsStore) return c.json({}, 501);
    const prefs = await prefsStore.load();
    return c.json(prefs);
  });

  api.patch("/preferences", async (c) => {
    if (!prefsStore) return c.json({}, 501);
    const body = await c.req.json().catch(() => ({}));
    prefsStore.save(body);
    const updated = await prefsStore.load();
    return c.json(updated);
  });

  // ─── Filesystem browsing ─────────────────────────────────────

  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(rawPath);
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json({ error: "Cannot read directory", path: basePath, dirs: [], home: homedir() }, 400);
    }
  });

  api.get("/fs/home", (c) => {
    return c.json({ home: homedir(), cwd: defaultCwd || process.cwd() });
  });

  // ─── OpenCode integration ─────────────────────────────────────

  api.get("/opencode/models", async (c) => {
    if (!opencodeBridge) {
      return c.json({ error: "OpenCode not configured" }, 501);
    }
    try {
      const models = await opencodeBridge.listModels();
      return c.json({ models });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/sessions/:id/context", async (c) => {
    const id = c.req.param("id");

    // Check if this is an OpenCode session
    if (opencodeBridge && opencodeBridge.isOpenCodeSession(id)) {
      try {
        const context = await opencodeBridge.getContext(id);
        return c.json(context);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 500);
      }
    }

    // Not an OpenCode session
    return c.json({ error: "Context only available for OpenCode sessions" }, 501);
  });

  // ─── Linear integration ─────────────────────────────────────

  api.get("/linear/issues", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    try {
      const issues = await linear.searchIssues({
        query: c.req.query("q") || undefined,
        team: c.req.query("team") || undefined,
        assignedToMe: c.req.query("assignedToMe") === "true",
        assignee: c.req.query("assignee") || undefined,
        state: c.req.query("state") || undefined,
        labels: c.req.query("labels")?.split(",").filter(Boolean),
        cycle: c.req.query("cycle") || undefined,
        createdAfter: c.req.query("createdAfter") || undefined,
        subscribedByMe: c.req.query("subscribedByMe") === "true",
        includeCompleted: c.req.query("includeCompleted") === "true",
        limit: Number(c.req.query("limit")) || 25,
      });
      return c.json({ issues });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/linear/issues/:id", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    try {
      const issue = await linear.getIssue(c.req.param("id"));
      return c.json(issue);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/linear/teams", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    try {
      const teams = await linear.listTeams();
      return c.json({ teams });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/linear/labels", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    try {
      const labels = await linear.listLabels(c.req.query("team") || undefined);
      return c.json({ labels });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/linear/cycles", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    const team = c.req.query("team");
    if (!team) return c.json({ error: "team query param required" }, 400);
    try {
      const cycles = await linear.listCycles(team);
      return c.json({ cycles });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/linear/states", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    const team = c.req.query("team");
    if (!team) return c.json({ error: "team query param required" }, 400);
    try {
      const states = await linear.listStates(team);
      return c.json({ states });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/linear/members", async (c) => {
    if (!process.env.LINEAR_API_KEY) {
      return c.json({ error: "LINEAR_API_KEY not configured" }, 501);
    }
    const team = c.req.query("team");
    if (!team) return c.json({ error: "team query param required" }, 400);
    try {
      const members = await linear.listMembers(team);
      return c.json({ members });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Claude session resumption ─────────────────────────────────────

  api.get("/claude-sessions", async (c) => {
    try {
      const projectsDir = join(homedir(), ".claude", "projects");
      const projects = await readdir(projectsDir, { withFileTypes: true });
      const sessions: Array<{ sessionId: string; cwd: string; lastModified: number }> = [];

      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectPath = join(projectsDir, project.name);
        const entries = await readdir(projectPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const sessionId = entry.name.replace(".jsonl", "");
            const filePath = join(projectPath, entry.name);
            const stat = await Bun.file(filePath).stat();

            // Read actual CWD from the JSONL file (user message contains the real cwd)
            let cwd = "";
            try {
              const content = await Bun.file(filePath).text();
              const lines = content.split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const msg = JSON.parse(line);
                  if (msg.type === "user" && msg.cwd) {
                    cwd = msg.cwd;
                    break;
                  }
                } catch {
                  // Skip malformed lines
                }
              }
            } catch {
              // If we can't read the file, skip this session
              continue;
            }

            if (!cwd) continue; // Skip sessions without CWD

            sessions.push({
              sessionId,
              cwd,
              lastModified: stat.mtime.getTime(),
            });
          }
        }
      }

      // Sort by last modified, most recent first
      sessions.sort((a, b) => b.lastModified - a.lastModified);

      return c.json({ sessions: sessions.slice(0, 50) }); // Limit to 50 most recent
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to list Claude sessions:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  return api;
}
