import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserPreferencesStore } from "../server/user-preferences.js";

describe("UserPreferencesStore", () => {
  let tmpDir: string;
  let store: UserPreferencesStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fossclaw-prefs-test-"));
    const filePath = join(tmpDir, "preferences.json");
    store = new UserPreferencesStore(filePath);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic Operations ──────────────────────────────────────────────

  describe("Basic Operations", () => {
    test("load returns default preferences for new file", async () => {
      const prefs = await store.load();
      expect(prefs).toBeDefined();
      expect(prefs.darkMode).toBe(false);
      expect(prefs.colorTheme).toBe("aurora");
      expect(prefs.sidebarWidth).toBe(260);
      expect(prefs.playbooks).toEqual([]);
    });

    test("can save and load preferences", async () => {
      store.save({
        darkMode: true,
        colorTheme: "ocean",
      });

      await store.flush();

      const prefs = await store.load();
      expect(prefs.darkMode).toBe(true);
      expect(prefs.colorTheme).toBe("ocean");
    });

    test("preferences persist across store instances", async () => {
      const filePath = join(tmpDir, "preferences.json");

      store.save({
        darkMode: true,
        colorTheme: "sunset",
      });
      await store.flush();

      // Create new store instance
      const store2 = new UserPreferencesStore(filePath);
      const prefs = await store2.load();

      expect(prefs.darkMode).toBe(true);
      expect(prefs.colorTheme).toBe("sunset");
    });
  });

  // ─── Preference Fields ─────────────────────────────────────────────

  describe("Preference Fields", () => {
    test("supports darkMode preference", async () => {
      store.save({ darkMode: true });
      await store.flush();
      let prefs = await store.load();
      expect(prefs.darkMode).toBe(true);
    });

    test("supports colorTheme preference", async () => {
      const themes = ["aurora", "ocean", "sunset", "forest", "lavender", "rose"] as const;

      for (const theme of themes) {
        store.save({ colorTheme: theme });
        await store.flush();
        const prefs = await store.load();
        expect(prefs.colorTheme).toBe(theme);
      }
    });

    test("supports sidebarWidth preference", async () => {
      store.save({ sidebarWidth: 400 });
      await store.flush();
      const prefs = await store.load();
      expect(prefs.sidebarWidth).toBe(400);
    });
  });
});
