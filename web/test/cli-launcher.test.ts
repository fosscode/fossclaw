import { describe, test, expect, beforeEach } from "bun:test";
import { CliLauncher } from "../server/cli-launcher.js";
import type { SdkSessionInfo } from "../server/cli-launcher.js";
import { NullSessionStore } from "../server/session-store.js";

/**
 * Unit tests for CliLauncher — testing session management methods
 * without spawning real processes. We use a high port number that
 * nothing listens on, plus NullSessionStore to avoid disk writes.
 */
describe("CliLauncher", () => {
  let launcher: CliLauncher;

  beforeEach(() => {
    launcher = new CliLauncher(59999, "/tmp", new NullSessionStore());
  });

  describe("restoreSession", () => {
    test("adds session to internal map", () => {
      const info: SdkSessionInfo = {
        sessionId: "test-restore-1",
        pid: 12345,
        state: "connected",
        model: "opus",
        permissionMode: "default",
        provider: "claude",
        cwd: "/home/user",
        createdAt: Date.now(),
      };

      launcher.restoreSession(info);

      const session = launcher.getSession("test-restore-1");
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe("test-restore-1");
      expect(session!.pid).toBe(12345);
      expect(session!.state).toBe("connected");
      expect(session!.model).toBe("opus");
      expect(session!.cwd).toBe("/home/user");
    });

    test("restored session appears in listSessions", () => {
      launcher.restoreSession({
        sessionId: "r1",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      launcher.restoreSession({
        sessionId: "r2",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      const sessions = launcher.listSessions();
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["r1", "r2"]);
    });
  });

  describe("hasProcess", () => {
    test("returns false for restored session (no subprocess)", () => {
      launcher.restoreSession({
        sessionId: "restored-1",
        pid: 99999,
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      expect(launcher.hasProcess("restored-1")).toBe(false);
    });

    test("returns false for unknown session", () => {
      expect(launcher.hasProcess("nonexistent")).toBe(false);
    });
  });

  describe("isAlive", () => {
    test("returns true for connected session", () => {
      launcher.restoreSession({
        sessionId: "alive-1",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      expect(launcher.isAlive("alive-1")).toBe(true);
    });

    test("returns true for starting session", () => {
      launcher.restoreSession({
        sessionId: "starting-1",
        state: "starting",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      expect(launcher.isAlive("starting-1")).toBe(true);
    });

    test("returns false for exited session", () => {
      launcher.restoreSession({
        sessionId: "exited-1",
        state: "exited",
        exitCode: 0,
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      expect(launcher.isAlive("exited-1")).toBe(false);
    });

    test("returns false for unknown session", () => {
      expect(launcher.isAlive("nonexistent")).toBe(false);
    });
  });

  describe("pruneExited", () => {
    test("removes exited sessions", () => {
      launcher.restoreSession({
        sessionId: "alive-1",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      launcher.restoreSession({
        sessionId: "dead-1",
        state: "exited",
        exitCode: 0,
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      launcher.restoreSession({
        sessionId: "dead-2",
        state: "exited",
        exitCode: 1,
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      const pruned = launcher.pruneExited();
      expect(pruned).toBe(2);

      const sessions = launcher.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("alive-1");
    });

    test("returns 0 when no exited sessions", () => {
      launcher.restoreSession({
        sessionId: "alive-1",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      expect(launcher.pruneExited()).toBe(0);
      expect(launcher.listSessions()).toHaveLength(1);
    });
  });

  describe("removeSession", () => {
    test("removes session from map", () => {
      launcher.restoreSession({
        sessionId: "to-remove",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      expect(launcher.getSession("to-remove")).toBeDefined();

      launcher.removeSession("to-remove");

      expect(launcher.getSession("to-remove")).toBeUndefined();
    });
  });

  describe("markConnected", () => {
    test("transitions starting session to connected", () => {
      launcher.restoreSession({
        sessionId: "mc-1",
        state: "starting",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      launcher.markConnected("mc-1");

      expect(launcher.getSession("mc-1")!.state).toBe("connected");
    });

    test("does not transition already connected session", () => {
      launcher.restoreSession({
        sessionId: "mc-2",
        state: "connected",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      launcher.markConnected("mc-2");

      // Still connected (no change)
      expect(launcher.getSession("mc-2")!.state).toBe("connected");
    });
  });
});
