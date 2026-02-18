import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuthSession {
  username: string;
  createdAt: number;
}

// ─── Session store (persisted to disk) ──────────────────────────────────────

const sessions = new Map<string, AuthSession>();

// Session expiry: 30 days
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const AUTH_SESSIONS_DIR = join(homedir(), ".fossclaw");
const AUTH_SESSIONS_FILE = join(AUTH_SESSIONS_DIR, "auth-sessions.json");

let flushTimer: Timer | undefined;

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushAuthSessions(), 2000);
}

/**
 * Persist auth sessions to disk so they survive server restarts.
 */
export async function flushAuthSessions(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  try {
    await mkdir(AUTH_SESSIONS_DIR, { recursive: true });
    const data: Record<string, AuthSession> = {};
    for (const [id, session] of sessions) {
      data[id] = session;
    }
    await writeFile(AUTH_SESSIONS_FILE, JSON.stringify(data), "utf-8");
  } catch {
    // Best-effort — don't crash the server if we can't write
  }
}

/**
 * Restore auth sessions from disk on startup.
 */
export async function restoreAuthSessions(): Promise<number> {
  try {
    const raw = await readFile(AUTH_SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, AuthSession>;
    const now = Date.now();
    let restored = 0;
    for (const [id, session] of Object.entries(data)) {
      // Skip expired sessions
      const age = (now - session.createdAt) / 1000;
      if (age > SESSION_MAX_AGE) continue;
      sessions.set(id, session);
      restored++;
    }
    return restored;
  } catch {
    // File doesn't exist yet or is corrupted — start fresh
    return 0;
  }
}

// ─── Session CRUD ───────────────────────────────────────────────────────────

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export function createSession(username: string): string {
  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    username,
    createdAt: Date.now(),
  });
  scheduleFlush();
  return sessionId;
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;

  // Check if session has expired
  const age = (Date.now() - session.createdAt) / 1000;
  if (age > SESSION_MAX_AGE) {
    sessions.delete(sessionId);
    scheduleFlush();
    return false;
  }

  return true;
}

export function deleteSession(sessionId: string | undefined): void {
  if (sessionId) {
    sessions.delete(sessionId);
    scheduleFlush();
  }
}

// ─── Credentials ────────────────────────────────────────────────────────────

let authCredentials: { username: string; password: string } | null = null;

/**
 * Set authentication credentials (called from server startup)
 */
export function setAuthCredentials(username: string, password: string): void {
  authCredentials = { username, password };
}

/**
 * Authentication is now always enabled (no opt-out)
 */
export function isAuthEnabled(): boolean {
  return true;
}

export function validateCredentials(username: string, password: string): boolean {
  if (!authCredentials) {
    throw new Error("Authentication credentials not initialized");
  }
  return username === authCredentials.username && password === authCredentials.password;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

// Middleware to protect routes (now always enforced)
export const requireAuth = createMiddleware(async (c, next) => {
  const sessionId = getCookie(c, "fossclaw_session");
  if (!validateSession(sessionId)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

// Helper to set auth cookie (HTTPS is now mandatory, so secure is always true)
export function setAuthCookie(c: any, sessionId: string): void {
  setCookie(c, "fossclaw_session", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

// Helper to clear auth cookie
export function clearAuthCookie(c: any): void {
  deleteCookie(c, "fossclaw_session", {
    path: "/",
  });
}

// Extract session from request (for WebSocket upgrade)
export function getSessionFromRequest(req: Request): string | undefined {
  const cookieHeader = req.headers.get("Cookie");
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=");
    if (name === "fossclaw_session") {
      return value;
    }
  }
  return undefined;
}
