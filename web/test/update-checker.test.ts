import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { UpdateChecker } from "../server/update-checker.js";

// ─── Version Comparison ─────────────────────────────────────────────

describe("UpdateChecker", () => {
  describe("version comparison (isNewerVersion)", () => {
    // We test this indirectly through checkForUpdates since isNewerVersion is private.
    // For unit-level version checks, we create a helper that accesses the private method.
    function isNewer(latest: string, current: string): boolean {
      // Access private method via prototype
      const checker = new UpdateChecker(current);
      return (checker as any).isNewerVersion(latest, current);
    }

    test("newer major version", () => {
      expect(isNewer("3.0.0", "2.18.3")).toBe(true);
    });

    test("newer minor version", () => {
      expect(isNewer("2.19.0", "2.18.3")).toBe(true);
    });

    test("newer patch version", () => {
      expect(isNewer("2.18.4", "2.18.3")).toBe(true);
    });

    test("same version is not newer", () => {
      expect(isNewer("2.18.3", "2.18.3")).toBe(false);
    });

    test("older major version is not newer", () => {
      expect(isNewer("1.0.0", "2.18.3")).toBe(false);
    });

    test("older minor version is not newer", () => {
      expect(isNewer("2.17.0", "2.18.3")).toBe(false);
    });

    test("older patch version is not newer", () => {
      expect(isNewer("2.18.2", "2.18.3")).toBe(false);
    });

    test("handles missing parts (two-part version)", () => {
      expect(isNewer("2.19", "2.18.3")).toBe(true);
    });

    test("handles missing parts on current", () => {
      expect(isNewer("2.18.1", "2.18")).toBe(true);
    });

    test("higher minor beats higher patch", () => {
      expect(isNewer("2.19.0", "2.18.99")).toBe(true);
    });

    test("major version jump from 0 to 1", () => {
      expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    });
  });

  // ─── Platform Detection ───────────────────────────────────────────

  describe("platform and arch detection", () => {
    test("getPlatform returns a known platform string", () => {
      const checker = new UpdateChecker("1.0.0");
      const platform = (checker as any).getPlatform();
      expect(["darwin", "linux", "windows"]).toContain(platform);
    });

    test("getArch returns a known arch string", () => {
      const checker = new UpdateChecker("1.0.0");
      const arch = (checker as any).getArch();
      expect(["arm64", "x64"]).toContain(arch);
    });

    test("getBinaryName returns platform-arch pattern", () => {
      const checker = new UpdateChecker("1.0.0");
      const name = (checker as any).getBinaryName();
      expect(name).toMatch(/^fossclaw-(darwin|linux|windows)-(arm64|x64)$/);
    });
  });

  // ─── checkForUpdates ──────────────────────────────────────────────

  describe("checkForUpdates", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("returns updateAvailable=true when newer version exists", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            tag_name: "v99.0.0",
            name: "v99.0.0",
            assets: [
              {
                name: `fossclaw-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}.tar.gz`,
                browser_download_url: "https://example.com/download.tar.gz",
                size: 50_000_000,
              },
            ],
            published_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 }
        )
      );

      const checker = new UpdateChecker("2.18.3");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(true);
      expect(result.currentVersion).toBe("2.18.3");
      expect(result.latestVersion).toBe("99.0.0");
      expect(result.downloadUrl).toBe("https://example.com/download.tar.gz");
    });

    test("returns updateAvailable=false when already on latest", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            tag_name: "v2.18.3",
            name: "v2.18.3",
            assets: [],
            published_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 }
        )
      );

      const checker = new UpdateChecker("2.18.3");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(false);
      expect(result.currentVersion).toBe("2.18.3");
      expect(result.latestVersion).toBe("2.18.3");
    });

    test("strips 'v' prefix from tag_name", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            tag_name: "v3.0.0",
            name: "v3.0.0",
            assets: [],
            published_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 }
        )
      );

      const checker = new UpdateChecker("2.0.0");
      const result = await checker.checkForUpdates();

      expect(result.latestVersion).toBe("3.0.0");
      expect(result.updateAvailable).toBe(true);
    });

    test("returns downloadUrl=undefined when asset not found for platform", async () => {
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            tag_name: "v99.0.0",
            name: "v99.0.0",
            assets: [
              {
                name: "fossclaw-some-other-platform.tar.gz",
                browser_download_url: "https://example.com/other.tar.gz",
                size: 50_000_000,
              },
            ],
            published_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 }
        )
      );

      const checker = new UpdateChecker("2.18.3");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(true);
      expect(result.downloadUrl).toBeUndefined();
    });

    test("handles GitHub API errors gracefully", async () => {
      globalThis.fetch = mock(async () =>
        new Response("Rate limited", { status: 403 })
      );

      const checker = new UpdateChecker("2.18.3");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(false);
      expect(result.currentVersion).toBe("2.18.3");
      expect(result.latestVersion).toBe("2.18.3");
    });

    test("handles network errors gracefully", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Network error");
      });

      const checker = new UpdateChecker("2.18.3");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(false);
      expect(result.currentVersion).toBe("2.18.3");
    });

    test("handles malformed JSON response gracefully", async () => {
      globalThis.fetch = mock(async () =>
        new Response("not json", { status: 200 })
      );

      const checker = new UpdateChecker("2.18.3");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(false);
    });
  });

  // ─── downloadAndInstall ───────────────────────────────────────────

  describe("downloadAndInstall", () => {
    test("throws when no download URL is available", async () => {
      const checker = new UpdateChecker("2.18.3");
      // downloadUrl is not set (no checkForUpdates called)
      await expect(checker.downloadAndInstall()).rejects.toThrow("No download URL available");
    });
  });
});

// ─── Cross-platform binary name tests ───────────────────────────────

describe("Cross-platform binary naming", () => {
  test("macOS arm64 binary name", () => {
    const checker = new UpdateChecker("1.0.0");
    // Override platform/arch for testing
    (checker as any).platform = "darwin";
    (checker as any).arch = "arm64";
    expect((checker as any).getBinaryName()).toBe("fossclaw-darwin-arm64");
  });

  test("macOS x64 binary name", () => {
    const checker = new UpdateChecker("1.0.0");
    (checker as any).platform = "darwin";
    (checker as any).arch = "x64";
    expect((checker as any).getBinaryName()).toBe("fossclaw-darwin-x64");
  });

  test("Linux arm64 binary name", () => {
    const checker = new UpdateChecker("1.0.0");
    (checker as any).platform = "linux";
    (checker as any).arch = "arm64";
    expect((checker as any).getBinaryName()).toBe("fossclaw-linux-arm64");
  });

  test("Linux x64 binary name", () => {
    const checker = new UpdateChecker("1.0.0");
    (checker as any).platform = "linux";
    (checker as any).arch = "x64";
    expect((checker as any).getBinaryName()).toBe("fossclaw-linux-x64");
  });

  test("Windows arm64 binary name", () => {
    const checker = new UpdateChecker("1.0.0");
    (checker as any).platform = "windows";
    (checker as any).arch = "arm64";
    expect((checker as any).getBinaryName()).toBe("fossclaw-windows-arm64");
  });

  test("Windows x64 binary name", () => {
    const checker = new UpdateChecker("1.0.0");
    (checker as any).platform = "windows";
    (checker as any).arch = "x64";
    expect((checker as any).getBinaryName()).toBe("fossclaw-windows-x64");
  });
});
