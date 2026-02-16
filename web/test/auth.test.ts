import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateCredentials, isAuthEnabled, createSession, validateSession, deleteSession } from "../server/auth.js";

describe("Authentication", () => {
  beforeEach(() => {
    // Clear auth env vars before each test
    delete process.env.FOSSCLAW_USER;
    delete process.env.FOSSCLAW_PASS;
  });

  afterEach(() => {
    // Clean up after tests
    delete process.env.FOSSCLAW_USER;
    delete process.env.FOSSCLAW_PASS;
  });

  // ─── Session Management ────────────────────────────────────────────

  describe("Session Management", () => {
    test("can create session", () => {
      const sessionId = createSession("testuser");
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    });

    test("validates valid session", () => {
      const sessionId = createSession("testuser");
      expect(validateSession(sessionId)).toBe(true);
    });

    test("rejects invalid session ID", () => {
      expect(validateSession("invalid-session-id")).toBe(false);
    });

    test("rejects undefined session", () => {
      expect(validateSession(undefined)).toBe(false);
    });

    test("can delete session", () => {
      const sessionId = createSession("testuser");
      expect(validateSession(sessionId)).toBe(true);

      deleteSession(sessionId);
      expect(validateSession(sessionId)).toBe(false);
    });

    test("each session has unique ID", () => {
      const session1 = createSession("user1");
      const session2 = createSession("user2");
      expect(session1).not.toBe(session2);
    });
  });

  // ─── Credential Validation ─────────────────────────────────────────

  describe("Credential Validation", () => {
    test("validates correct credentials", () => {
      process.env.FOSSCLAW_USER = "testuser";
      process.env.FOSSCLAW_PASS = "testpass";

      expect(validateCredentials("testuser", "testpass")).toBe(true);
    });

    test("rejects invalid credentials", () => {
      process.env.FOSSCLAW_USER = "testuser";
      process.env.FOSSCLAW_PASS = "testpass";

      expect(validateCredentials("wrong", "credentials")).toBe(false);
    });

    test("rejects wrong username", () => {
      process.env.FOSSCLAW_USER = "testuser";
      process.env.FOSSCLAW_PASS = "testpass";

      expect(validateCredentials("wronguser", "testpass")).toBe(false);
    });

    test("rejects wrong password", () => {
      process.env.FOSSCLAW_USER = "testuser";
      process.env.FOSSCLAW_PASS = "testpass";

      expect(validateCredentials("testuser", "wrongpass")).toBe(false);
    });

    test("credentials are case-sensitive", () => {
      process.env.FOSSCLAW_USER = "TestUser";
      process.env.FOSSCLAW_PASS = "TestPass";

      expect(validateCredentials("testuser", "testpass")).toBe(false);
      expect(validateCredentials("TestUser", "testpass")).toBe(false);
      expect(validateCredentials("testuser", "TestPass")).toBe(false);
      expect(validateCredentials("TestUser", "TestPass")).toBe(true);
    });
  });

  // ─── Auth State Detection ──────────────────────────────────────────

  describe("Auth State Detection", () => {
    test("detects when auth is enabled", () => {
      process.env.FOSSCLAW_USER = "user";
      process.env.FOSSCLAW_PASS = "pass";

      expect(isAuthEnabled()).toBe(true);
    });

    test("detects when auth is disabled", () => {
      expect(isAuthEnabled()).toBe(false);
    });

    test("requires both username and password", () => {
      process.env.FOSSCLAW_USER = "user";
      expect(isAuthEnabled()).toBe(false);

      delete process.env.FOSSCLAW_USER;
      process.env.FOSSCLAW_PASS = "pass";
      expect(isAuthEnabled()).toBe(false);
    });

    test("empty values don't enable auth", () => {
      process.env.FOSSCLAW_USER = "";
      process.env.FOSSCLAW_PASS = "";
      expect(isAuthEnabled()).toBe(false);
    });
  });

  // ─── Special Characters in Credentials ─────────────────────────────

  describe("Special Characters", () => {
    test("handles special characters in password", () => {
      const password = "p@ssw0rd!#$%^&*()";
      process.env.FOSSCLAW_USER = "user";
      process.env.FOSSCLAW_PASS = password;

      expect(validateCredentials("user", password)).toBe(true);
    });

    test("handles special characters in username", () => {
      const username = "user@example.com";
      process.env.FOSSCLAW_USER = username;
      process.env.FOSSCLAW_PASS = "pass";

      expect(validateCredentials(username, "pass")).toBe(true);
    });

    test("handles colon in password", () => {
      const password = "pass:with:colons";
      process.env.FOSSCLAW_USER = "user";
      process.env.FOSSCLAW_PASS = password;

      expect(validateCredentials("user", password)).toBe(true);
    });

    test("handles unicode characters", () => {
      const password = "пароль密码🔐";
      process.env.FOSSCLAW_USER = "user";
      process.env.FOSSCLAW_PASS = password;

      expect(validateCredentials("user", password)).toBe(true);
    });

    test("handles whitespace in credentials", () => {
      process.env.FOSSCLAW_USER = " user ";
      process.env.FOSSCLAW_PASS = " pass ";

      expect(validateCredentials(" user ", " pass ")).toBe(true);
      expect(validateCredentials("user", "pass")).toBe(false);
    });
  });

  // ─── Session Expiry ────────────────────────────────────────────────

  describe("Session Expiry", () => {
    test("newly created sessions are valid", () => {
      const sessionId = createSession("user");
      expect(validateSession(sessionId)).toBe(true);
    });

    test("sessions persist across validation calls", () => {
      const sessionId = createSession("user");

      expect(validateSession(sessionId)).toBe(true);
      expect(validateSession(sessionId)).toBe(true);
      expect(validateSession(sessionId)).toBe(true);
    });
  });

  // ─── Multiple Sessions ─────────────────────────────────────────────

  describe("Multiple Sessions", () => {
    test("can create multiple sessions for different users", () => {
      const session1 = createSession("user1");
      const session2 = createSession("user2");
      const session3 = createSession("user3");

      expect(validateSession(session1)).toBe(true);
      expect(validateSession(session2)).toBe(true);
      expect(validateSession(session3)).toBe(true);
    });

    test("deleting one session doesn't affect others", () => {
      const session1 = createSession("user1");
      const session2 = createSession("user2");

      deleteSession(session1);

      expect(validateSession(session1)).toBe(false);
      expect(validateSession(session2)).toBe(true);
    });

    test("can create multiple sessions for same user", () => {
      const session1 = createSession("user");
      const session2 = createSession("user");

      expect(session1).not.toBe(session2);
      expect(validateSession(session1)).toBe(true);
      expect(validateSession(session2)).toBe(true);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    test("handles empty strings in credentials", () => {
      process.env.FOSSCLAW_USER = "user";
      process.env.FOSSCLAW_PASS = "pass";

      expect(validateCredentials("", "")).toBe(false);
      expect(validateCredentials("user", "")).toBe(false);
      expect(validateCredentials("", "pass")).toBe(false);
    });

    test("deleteSession with undefined doesn't crash", () => {
      expect(() => deleteSession(undefined)).not.toThrow();
    });

    test("deleteSession with invalid ID doesn't crash", () => {
      expect(() => deleteSession("nonexistent")).not.toThrow();
    });

    test("very long credentials work", () => {
      const longUsername = "a".repeat(1000);
      const longPassword = "b".repeat(1000);

      process.env.FOSSCLAW_USER = longUsername;
      process.env.FOSSCLAW_PASS = longPassword;

      expect(validateCredentials(longUsername, longPassword)).toBe(true);
    });
  });
});
