import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";

// In-memory session store (simple Map)
const sessions = new Map<string, { username: string; createdAt: number }>();

// Session expiry: 30 days
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export function createSession(username: string): string {
  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    username,
    createdAt: Date.now(),
  });
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
    return false;
  }

  return true;
}

export function deleteSession(sessionId: string | undefined): void {
  if (sessionId) {
    sessions.delete(sessionId);
  }
}

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
