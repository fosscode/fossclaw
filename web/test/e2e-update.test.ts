/**
 * E2E Software Update Tests
 *
 * Tests the update checker, binary naming, and update flow across platforms.
 * Supports macOS (darwin) and Linux environments.
 *
 * Run with: bun test e2e-update.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod, stat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, platform, arch, homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "bun";
import { UpdateChecker } from "../server/update-checker.js";

const PLATFORM = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const BINARY_NAME = `fossclaw-${PLATFORM}-${ARCH}`;
const BINARY_PATH = join(import.meta.dir, "..", "..", "dist", BINARY_NAME);
const binaryExists = existsSync(BINARY_PATH);

// ─── Cross-Platform Update Checker Tests ────────────────────────────

describe("Cross-Platform Update Checker", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe(`platform: ${PLATFORM} / arch: ${ARCH}`, () => {
    test("detects correct platform", () => {
      const checker = new UpdateChecker("1.0.0");
      const detectedPlatform = (checker as any).platform;
      expect(detectedPlatform).toBe(PLATFORM);
    });

    test("detects correct architecture", () => {
      const checker = new UpdateChecker("1.0.0");
      const detectedArch = (checker as any).arch;
      expect(detectedArch).toBe(ARCH);
    });

    test("generates correct binary name for current platform", () => {
      const checker = new UpdateChecker("1.0.0");
      const name = (checker as any).getBinaryName();
      expect(name).toBe(BINARY_NAME);
    });

    test("finds matching asset in release", async () => {
      const expectedAssetName = `${BINARY_NAME}.tar.gz`;

      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            tag_name: "v99.0.0",
            name: "v99.0.0",
            assets: [
              { name: "fossclaw-darwin-arm64.tar.gz", browser_download_url: "https://example.com/darwin-arm64.tar.gz", size: 50_000_000 },
              { name: "fossclaw-darwin-x64.tar.gz", browser_download_url: "https://example.com/darwin-x64.tar.gz", size: 50_000_000 },
              { name: "fossclaw-linux-arm64.tar.gz", browser_download_url: "https://example.com/linux-arm64.tar.gz", size: 50_000_000 },
              { name: "fossclaw-linux-x64.tar.gz", browser_download_url: "https://example.com/linux-x64.tar.gz", size: 50_000_000 },
              { name: "fossclaw-windows-arm64.tar.gz", browser_download_url: "https://example.com/windows-arm64.tar.gz", size: 50_000_000 },
              { name: "fossclaw-windows-x64.tar.gz", browser_download_url: "https://example.com/windows-x64.tar.gz", size: 50_000_000 },
            ],
            published_at: "2026-01-01T00:00:00Z",
          }),
          { status: 200 }
        )
      );

      const checker = new UpdateChecker("1.0.0");
      const result = await checker.checkForUpdates();

      expect(result.updateAvailable).toBe(true);
      expect(result.downloadUrl).toContain(PLATFORM);
      expect(result.downloadUrl).toContain(ARCH);
    });
  });

  // Test all platform/arch combinations
  const platforms = ["darwin", "linux", "windows"] as const;
  const architectures = ["arm64", "x64"] as const;

  for (const p of platforms) {
    for (const a of architectures) {
      test(`binary name for ${p}-${a}`, () => {
        const checker = new UpdateChecker("1.0.0");
        (checker as any).platform = p;
        (checker as any).arch = a;
        const name = (checker as any).getBinaryName();
        expect(name).toBe(`fossclaw-${p}-${a}`);
      });
    }
  }
});

// ─── Update Flow Simulation Tests ───────────────────────────────────

describe("Update Flow Simulation", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "update-flow-test-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("simulates full update directory structure", async () => {
    // Simulate current installation
    const currentDir = join(testDir, "current");
    await mkdir(currentDir, { recursive: true });
    await mkdir(join(currentDir, "dist", "assets"), { recursive: true });

    // Create fake current binary
    await writeFile(join(currentDir, BINARY_NAME), "current-binary-v1");
    await chmod(join(currentDir, BINARY_NAME), 0o755);
    await writeFile(join(currentDir, "dist", "index.html"), "<html>v1</html>");
    await writeFile(join(currentDir, "dist", "assets", "app.js"), "// v1");

    // Simulate downloaded update
    const updateDir = join(testDir, "update");
    await mkdir(updateDir, { recursive: true });
    await mkdir(join(updateDir, "dist", "assets"), { recursive: true });

    await writeFile(join(updateDir, BINARY_NAME), "new-binary-v2");
    await writeFile(join(updateDir, `${BINARY_NAME}.bin`), "new-binary-bin-v2");
    await writeFile(join(updateDir, "dist", "index.html"), "<html>v2</html>");
    await writeFile(join(updateDir, "dist", "assets", "app.js"), "// v2");

    // Verify initial state
    const currentBinary = await readFile(join(currentDir, BINARY_NAME), "utf-8");
    expect(currentBinary).toBe("current-binary-v1");

    // Simulate backup
    const backupPath = join(currentDir, `${BINARY_NAME}.backup`);
    await writeFile(backupPath, await readFile(join(currentDir, BINARY_NAME)));

    // Simulate install (copy new binary over)
    await writeFile(
      join(currentDir, BINARY_NAME),
      await readFile(join(updateDir, BINARY_NAME)),
    );
    await chmod(join(currentDir, BINARY_NAME), 0o755);

    // Simulate install .bin
    await writeFile(
      join(currentDir, `${BINARY_NAME}.bin`),
      await readFile(join(updateDir, `${BINARY_NAME}.bin`)),
    );

    // Verify updated state
    const updatedBinary = await readFile(join(currentDir, BINARY_NAME), "utf-8");
    expect(updatedBinary).toBe("new-binary-v2");

    const updatedBin = await readFile(join(currentDir, `${BINARY_NAME}.bin`), "utf-8");
    expect(updatedBin).toBe("new-binary-bin-v2");

    // Verify backup exists
    const backup = await readFile(backupPath, "utf-8");
    expect(backup).toBe("current-binary-v1");

    // Verify permissions
    const stats = await stat(join(currentDir, BINARY_NAME));
    expect(stats.mode & 0o755).toBe(0o755);
  });

  test("simulates dist folder replacement", async () => {
    const installDir = join(testDir, "dist-replace");
    const oldDist = join(installDir, "dist");
    const newDist = join(testDir, "new-dist");

    // Create old dist
    await mkdir(join(oldDist, "assets"), { recursive: true });
    await writeFile(join(oldDist, "index.html"), "<html>old</html>");
    await writeFile(join(oldDist, "assets", "old-file.js"), "old");

    // Create new dist
    await mkdir(join(newDist, "assets"), { recursive: true });
    await writeFile(join(newDist, "index.html"), "<html>new</html>");
    await writeFile(join(newDist, "assets", "new-file.js"), "new");

    // Simulate dist replacement using cp -r (same as updater-helper)
    const proc = spawn(["rm", "-rf", oldDist]);
    await proc.exited;
    const copyProc = spawn(["cp", "-r", newDist, oldDist]);
    await copyProc.exited;

    // Verify new dist
    expect(await readFile(join(oldDist, "index.html"), "utf-8")).toBe("<html>new</html>");
    expect(await readFile(join(oldDist, "assets", "new-file.js"), "utf-8")).toBe("new");
    expect(existsSync(join(oldDist, "assets", "old-file.js"))).toBe(false);
  });

  test("tar extraction works on this platform", async () => {
    const tarDir = join(testDir, "tar-test");
    await mkdir(tarDir, { recursive: true });

    // Create a file and tar it
    const contentDir = join(tarDir, "content");
    await mkdir(contentDir, { recursive: true });
    await writeFile(join(contentDir, "test.txt"), "Hello from tar");

    // Create tarball
    const createProc = spawn(["tar", "-czf", join(tarDir, "test.tar.gz"), "-C", tarDir, "content"]);
    const createExit = await createProc.exited;
    expect(createExit).toBe(0);
    expect(existsSync(join(tarDir, "test.tar.gz"))).toBe(true);

    // Extract to new location
    const extractDir = join(tarDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    const extractProc = spawn(["tar", "-xzf", join(tarDir, "test.tar.gz"), "-C", extractDir]);
    const extractExit = await extractProc.exited;
    expect(extractExit).toBe(0);

    // Verify extraction
    const extracted = await readFile(join(extractDir, "content", "test.txt"), "utf-8");
    expect(extracted).toBe("Hello from tar");
  });
});

// ─── Binary Release Tests (platform-specific) ──────────────────────

describe.skipIf(!binaryExists)(`Binary Update Tests (${PLATFORM}-${ARCH})`, () => {
  test("binary exists and is executable", async () => {
    const stats = await stat(BINARY_PATH);
    expect(stats.mode & 0o100).toBeGreaterThan(0); // User execute bit

    // macOS-specific: Check that the binary is not quarantined
    if (PLATFORM === "darwin") {
      const proc = spawn(["xattr", "-l", BINARY_PATH], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      // If xattr exits 0, check that quarantine isn't set
      if (exitCode === 0 && output.includes("com.apple.quarantine")) {
        console.warn("Binary has quarantine flag - may need: xattr -d com.apple.quarantine " + BINARY_PATH);
      }
    }
  });

  test("binary has reasonable file size", () => {
    const stats = readFileSync(BINARY_PATH);
    const sizeMB = stats.byteLength / (1024 * 1024);
    // Bun-compiled binaries are typically 20-150MB
    expect(sizeMB).toBeGreaterThan(20);
    expect(sizeMB).toBeLessThan(200);
  });
});

// ─── Platform-Specific Path Tests ───────────────────────────────────

describe("Platform-Specific Paths", () => {
  test("tmp directory exists and is writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "update-path-test-"));
    expect(existsSync(dir)).toBe(true);

    await writeFile(join(dir, "test.txt"), "writable");
    expect(await readFile(join(dir, "test.txt"), "utf-8")).toBe("writable");

    await rm(dir, { recursive: true, force: true });
  });

  test("fossclaw data directory path is valid", () => {
    const dataDir = join(homedir(), ".fossclaw");
    // Just verify the path construction works
    expect(dataDir).toContain(".fossclaw");
    expect(join(dataDir, "tmp")).toContain("tmp");
    expect(join(dataDir, "updater-helper")).toContain("updater-helper");
  });

  test("process.argv[0] is available for binary path detection", () => {
    expect(process.argv[0]).toBeString();
    expect(process.argv[0].length).toBeGreaterThan(0);
  });

  test("chmod works on this platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chmod-test-"));
    const file = join(dir, "test-binary");
    await writeFile(file, "#!/bin/sh\necho hello");
    await chmod(file, 0o755);

    const stats = await stat(file);
    expect(stats.mode & 0o755).toBe(0o755);

    await rm(dir, { recursive: true, force: true });
  });
});

// ─── macOS-Specific Tests ───────────────────────────────────────────

describe.skipIf(PLATFORM !== "darwin")("macOS-Specific Update Tests", () => {
  test("codesign is available (for binary signing)", async () => {
    const proc = spawn(["which", "codesign"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log("codesign is available for binary signing");
    } else {
      console.log("codesign not found (Xcode command line tools may not be installed)");
    }
  });

  test("detects ARM vs Intel correctly", () => {
    const checker = new UpdateChecker("1.0.0");
    const detectedArch = (checker as any).arch;
    if (process.arch === "arm64") {
      expect(detectedArch).toBe("arm64");
    } else {
      expect(detectedArch).toBe("x64");
    }
  });
});

// ─── Linux-Specific Tests ───────────────────────────────────────────

describe.skipIf(PLATFORM !== "linux")("Linux-Specific Update Tests", () => {
  test("uname reports correct architecture", async () => {
    const proc = spawn(["uname", "-m"], { stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      if (process.arch === "arm64") {
        expect(output).toMatch(/aarch64|arm64/);
      } else {
        expect(output).toMatch(/x86_64|amd64/);
      }
    }
  });

  test("file permissions work correctly on Linux", async () => {
    const dir = await mkdtemp(join(tmpdir(), "linux-perms-"));
    const file = join(dir, "test-exec");
    await writeFile(file, "#!/bin/sh\necho hello");
    await chmod(file, 0o755);

    const stats = await stat(file);
    // Linux should preserve all permission bits
    expect(stats.mode & 0o755).toBe(0o755);

    await rm(dir, { recursive: true, force: true });
  });

  test("systemd service file path pattern", () => {
    // Verify that the expected service file paths are correct for Linux
    const serviceFile = "/etc/systemd/system/fossclaw.service";
    // Just verify path construction
    expect(serviceFile).toContain("fossclaw");
  });
});
