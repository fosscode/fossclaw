process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { OpenCodeBridge } from "./opencode-bridge.js";
import { FileSessionStore } from "./session-store.js";
import { UserPreferencesStore } from "./user-preferences.js";
import { OllamaClient } from "./ollama-client.js";
import { generateSelfSignedCert } from "./cert-generator.js";
import { isAuthEnabled, validateSession, getSessionFromRequest, setAuthCredentials, restoreAuthSessions, flushAuthSessions } from "./auth.js";
import { ensureCredentials, getCredentialsFilePath } from "./credential-generator.js";
import { CronJobStore } from "./cron-store.js";
import { setLinearApiKey } from "./linear-client.js";
import { setGitHubToken } from "./cron-checkers.js";
import { CronScheduler } from "./cron-scheduler.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__FOSSCLAW_PACKAGE_ROOT || resolve(__dirname, "..");

// In production mode (binary), NODE_ENV should be set to "production"
if (!process.env.NODE_ENV && process.env.__FOSSCLAW_PACKAGE_ROOT) {
  process.env.NODE_ENV = "production";
}

const port = Number(process.env.PORT) || 3456;
const defaultCwd = process.env.FOSSCLAW_CWD || process.cwd();
// HTTPS is mandatory except in test environments
const useHttps = process.env.NODE_ENV !== "test";
const httpsHostname = process.env.FOSSCLAW_HTTPS_HOSTNAME || "localhost";
const certDir = process.env.FOSSCLAW_CERT_DIR || resolve(homedir(), ".fossclaw", "certs");

// Session cleanup: how long to keep inactive sessions (default: 7 days, 0 = never cleanup)
const sessionTTLDays = Number(process.env.FOSSCLAW_SESSION_TTL_DAYS) || 7;
const sessionTTLMs = sessionTTLDays * 24 * 60 * 60 * 1000;

const store = new FileSessionStore();
const prefsStore = new UserPreferencesStore();

// Ollama client for auto-naming sessions (env vars override, then preferences)
let ollamaClient: OllamaClient | undefined;

const savedPrefs = await prefsStore.load();
{
  const envUrl = process.env.OLLAMA_URL;
  const envModel = process.env.OLLAMA_MODEL;
  const ollamaUrl = envUrl || savedPrefs.ollamaUrl;
  const ollamaModel = envModel || savedPrefs.ollamaModel;

  // Initialize Linear API key from saved preferences (env var takes precedence at runtime via getApiKey)
  if (savedPrefs.linearApiKey && !process.env.LINEAR_API_KEY) {
    setLinearApiKey(savedPrefs.linearApiKey);
  }

  // Initialize GitHub token from saved preferences (env var takes precedence at runtime via getGitHubToken)
  if (savedPrefs.githubToken && !process.env.GITHUB_TOKEN) {
    setGitHubToken(savedPrefs.githubToken);
  }

  if (ollamaUrl) {
    ollamaClient = new OllamaClient(ollamaUrl, ollamaModel || undefined);
    ollamaClient.isAvailable().then((available) => {
      if (available) {
        console.log(`[ollama] LLM naming enabled (${ollamaUrl}, model: ${ollamaModel || "default"})`);
      } else {
        console.warn(`[ollama] Service at ${ollamaUrl} is not available or model not found, LLM naming disabled`);
        ollamaClient = undefined;
      }
    }).catch(() => {
      console.warn(`[ollama] Failed to connect to ${ollamaUrl}, LLM naming disabled`);
      ollamaClient = undefined;
    });
  }
}

const wsBridge = new WsBridge(store, ollamaClient);
wsBridge.setPrefsStore(prefsStore);
const launcher = new CliLauncher(port, defaultCwd, store, useHttps);

// OpenCode bridge — uses a dedicated port for the opencode serve process
const opencodePort = Number(process.env.OPENCODE_PORT) || (port + 100);
const opencodeBridge = new OpenCodeBridge(opencodePort);
opencodeBridge.setWsBridge(wsBridge);
launcher.setOpenCodeBridge(opencodeBridge);

// Cron job scheduler
const cronStore = new CronJobStore();
const cronScheduler = new CronScheduler(cronStore, launcher, wsBridge, store);

// ─── Authentication setup — ensure credentials exist ────────────────────────
const credentials = await ensureCredentials();
setAuthCredentials(credentials.username, credentials.password);
const restoredAuthSessions = await restoreAuthSessions();
if (restoredAuthSessions > 0) {
  console.log(`[auth] Restored ${restoredAuthSessions} login session(s) from disk`);
}

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, defaultCwd, opencodeBridge, store, prefsStore, cronStore, cronScheduler));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

// ─── Startup recovery — restore persisted sessions ───────────────────────────
const persisted = await store.loadAll();
let restored = 0;
let archived = 0;
for (const session of persisted) {
  const { meta, state, history } = session;
  // Check if the CLI process is still alive
  let alive = false;
  if (meta.pid) {
    try {
      process.kill(meta.pid, 0);
      alive = true;
    } catch {
      // Process is dead
    }
  }

  if (alive) {
    launcher.restoreSession({
      sessionId: meta.sessionId,
      pid: meta.pid,
      state: "connected",
      model: meta.model,
      permissionMode: meta.permissionMode,
      provider: meta.provider as "claude" | "opencode" | undefined,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      sessionName: meta.sessionName,
    });
    wsBridge.restoreSession(meta.sessionId, state, history, false);
    restored++;
  } else {
    // Dead process — restore as archived (read-only) session
    launcher.restoreSession({
      sessionId: meta.sessionId,
      state: "exited",
      exitCode: -1,
      model: meta.model,
      permissionMode: meta.permissionMode,
      provider: meta.provider as "claude" | "opencode" | undefined,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      sessionName: meta.sessionName,
      archived: true,
    });
    wsBridge.restoreSession(meta.sessionId, state, history, true);
    archived++;
  }
}
if (restored > 0 || archived > 0) {
  console.log(`[startup] Restored ${restored} live session(s) and ${archived} archived session(s) from disk`);
}

// ─── Start cron scheduler ────────────────────────────────────────────────────
cronScheduler.start();
const cronJobs = await cronStore.loadJobs();
const enabledCronJobs = cronJobs.filter((j) => j.enabled).length;
if (cronJobs.length > 0) {
  console.log(`[cron] Loaded ${cronJobs.length} cron job(s) (${enabledCronJobs} enabled)`);
}

// ─── TLS setup ───────────────────────────────────────────────────────────────
let tlsOptions: { cert: string; key: string } | undefined;
if (useHttps) {
  const certPaths = await generateSelfSignedCert(certDir, httpsHostname);
  tlsOptions = {
    cert: Bun.file(certPaths.cert),
    key: Bun.file(certPaths.key),
  } as any;
}

function checkAuth(req: Request): boolean {
  if (!isAuthEnabled()) return true;
  const sessionId = getSessionFromRequest(req);
  return validateSession(sessionId);
}

const server = Bun.serve<SocketData>({
  port,
  ...(tlsOptions && { tls: tlsOptions }),
  fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      if (!checkAuth(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      }
    },
  },
});

const protocol = useHttps ? "https" : "http";
const wsProtocol = useHttps ? "wss" : "ws";
const httpsStatus = useHttps
  ? "enabled (mandatory, self-signed cert)"
  : "disabled (test mode only)";

console.log(`FossClaw running on ${protocol}://localhost:${server.port}`);
console.log(`  Default CWD:       ${defaultCwd}`);
console.log(`  HTTPS:             ${httpsStatus}`);
console.log(`  Auth:              enabled (mandatory, username: ${credentials.username})`);
console.log(`  Credentials file:  ${getCredentialsFilePath()}`);
console.log(`  Auto-naming:       smart extraction (always on)${ollamaClient ? " + Ollama LLM" : ""}`);
console.log(`  Session TTL:       ${sessionTTLMs > 0 ? `${sessionTTLDays} days` : "disabled (set FOSSCLAW_SESSION_TTL_DAYS to enable)"}`);
console.log(`  CLI WebSocket:     ${wsProtocol}://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ${wsProtocol}://localhost:${server.port}/ws/browser/:sessionId`);
console.log(`  GitHub Token:      ${process.env.GITHUB_TOKEN || savedPrefs.githubToken ? "configured" : "not set (cron PR/CI features need GITHUB_TOKEN)"}`);
console.log(`  Cron Jobs:         ${enabledCronJobs} of ${cronJobs.length} enabled`);

// In dev mode, log that Vite should be run separately
if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: run 'bun run dev:vite' in another terminal for the frontend");
}

// ─── PID monitor — detect dead orphan CLIs every 30s ─────────────────────────
setInterval(() => {
  for (const session of launcher.listSessions()) {
    if (session.state === "exited") continue;
    if (launcher.hasProcess(session.sessionId)) continue;
    // Restored session without a managed process — check if PID is still alive
    if (session.pid) {
      try {
        process.kill(session.pid, 0);
      } catch {
        console.log(`[pid-monitor] Session ${session.sessionId} PID ${session.pid} is dead, marking exited`);
        session.state = "exited";
        session.exitCode = -1;
      }
    }
  }
}, 30_000);

// ─── Session cleanup — remove old archived sessions based on TTL ────────────
if (sessionTTLMs > 0) {
  setInterval(async () => {
    const now = Date.now();
    const sessions = await store.loadAll();
    let cleaned = 0;

    for (const session of sessions) {
      const { meta } = session;
      // Only cleanup archived/exited sessions
      const launcherSession = launcher.getSession(meta.sessionId);
      if (launcherSession && launcherSession.state !== "exited") {
        continue; // Skip live sessions
      }

      // Use lastActivityAt if available, otherwise fall back to createdAt
      const lastActivity = meta.lastActivityAt || meta.createdAt;
      const age = now - lastActivity;

      if (age > sessionTTLMs) {
        console.log(`[cleanup] Removing inactive session ${meta.sessionId} (last activity: ${Math.floor(age / (24 * 60 * 60 * 1000))} days ago)`);
        launcher.removeSession(meta.sessionId);
        wsBridge.closeSession(meta.sessionId);
        await store.remove(meta.sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[cleanup] Cleaned up ${cleaned} inactive session(s)`);
    }
  }, 60 * 60 * 1000); // Run every hour
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown() {
  console.log("[shutdown] Flushing stores...");
  cronScheduler.stop();
  await cronStore.flush();
  await store.flush();
  await prefsStore.flush();
  await flushAuthSessions();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
