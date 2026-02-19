import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

// ─── Updater Helper Logic Tests ─────────────────────────────────────
// We test the core logic functions by reimplementing them here since
// the updater-helper is a standalone script. This validates the
// algorithms without needing to compile and run the binary.

describe("Updater Helper Logic", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "updater-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ─── Argument Parsing ────────────────────────────────────────────

  describe("argument parsing", () => {
    function parseArgs(args: string[]): Record<string, string | number> {
      const parsed: Record<string, string | number> = {};
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i].replace(/^--/, "");
        const value = args[i + 1];
        switch (key) {
          case "current-dir":
            parsed.currentDir = value;
            break;
          case "new-binary":
            parsed.newBinary = value;
            break;
          case "new-binary-bin":
            parsed.newBinaryBin = value;
            break;
          case "new-dist":
            parsed.newDist = value;
            break;
          case "pid":
            parsed.pid = parseInt(value, 10);
            break;
        }
      }
      return parsed;
    }

    test("parses all arguments correctly", () => {
      const args = [
        "--current-dir", "/opt/fossclaw",
        "--new-binary", "/tmp/fossclaw-darwin-arm64",
        "--new-binary-bin", "/tmp/fossclaw-darwin-arm64.bin",
        "--new-dist", "/tmp/dist",
        "--pid", "12345",
      ];
      const parsed = parseArgs(args);
      expect(parsed.currentDir).toBe("/opt/fossclaw");
      expect(parsed.newBinary).toBe("/tmp/fossclaw-darwin-arm64");
      expect(parsed.newBinaryBin).toBe("/tmp/fossclaw-darwin-arm64.bin");
      expect(parsed.newDist).toBe("/tmp/dist");
      expect(parsed.pid).toBe(12345);
    });

    test("handles partial arguments", () => {
      const args = [
        "--current-dir", "/opt/fossclaw",
        "--pid", "99",
      ];
      const parsed = parseArgs(args);
      expect(parsed.currentDir).toBe("/opt/fossclaw");
      expect(parsed.pid).toBe(99);
      expect(parsed.newBinary).toBeUndefined();
    });
  });

  // ─── Backup Logic ────────────────────────────────────────────────

  describe("backup logic", () => {
    const BINARY_FILES = [
      "fossclaw-darwin-arm64",
      "fossclaw-darwin-x64",
      "fossclaw-linux-arm64",
      "fossclaw-linux-x64",
    ];

    async function backupCurrentBinary(currentDir: string): Promise<string[]> {
      const backedUp: string[] = [];
      for (const file of BINARY_FILES) {
        const path = join(currentDir, file);
        const binPath = join(currentDir, `${file}.bin`);
        const backupPath = join(currentDir, `${file}.backup`);
        const backupBinPath = join(currentDir, `${file}.bin.backup`);

        if (existsSync(path)) {
          const content = await readFile(path);
          await writeFile(backupPath, content);
          backedUp.push(file);

          if (existsSync(binPath)) {
            const binContent = await readFile(binPath);
            await writeFile(backupBinPath, binContent);
          }
        }
      }
      return backedUp;
    }

    test("backs up existing darwin-arm64 binary", async () => {
      const binaryPath = join(testDir, "fossclaw-darwin-arm64");
      await writeFile(binaryPath, "binary-content");

      const backed = await backupCurrentBinary(testDir);

      expect(backed).toContain("fossclaw-darwin-arm64");
      expect(existsSync(join(testDir, "fossclaw-darwin-arm64.backup"))).toBe(true);

      const backupContent = await readFile(join(testDir, "fossclaw-darwin-arm64.backup"), "utf-8");
      expect(backupContent).toBe("binary-content");
    });

    test("backs up both wrapper and .bin file", async () => {
      await writeFile(join(testDir, "fossclaw-linux-x64"), "wrapper");
      await writeFile(join(testDir, "fossclaw-linux-x64.bin"), "bin-content");

      await backupCurrentBinary(testDir);

      expect(existsSync(join(testDir, "fossclaw-linux-x64.backup"))).toBe(true);
      expect(existsSync(join(testDir, "fossclaw-linux-x64.bin.backup"))).toBe(true);

      const backupBin = await readFile(join(testDir, "fossclaw-linux-x64.bin.backup"), "utf-8");
      expect(backupBin).toBe("bin-content");
    });

    test("skips non-existent binaries", async () => {
      // Only create one binary
      await writeFile(join(testDir, "fossclaw-darwin-arm64"), "content");

      const backed = await backupCurrentBinary(testDir);

      expect(backed).toEqual(["fossclaw-darwin-arm64"]);
      expect(existsSync(join(testDir, "fossclaw-linux-x64.backup"))).toBe(false);
    });

    test("backs up multiple binaries in same directory", async () => {
      await writeFile(join(testDir, "fossclaw-darwin-arm64"), "mac-arm");
      await writeFile(join(testDir, "fossclaw-linux-x64"), "linux-x64");

      const backed = await backupCurrentBinary(testDir);

      expect(backed).toContain("fossclaw-darwin-arm64");
      expect(backed).toContain("fossclaw-linux-x64");
      expect(backed.length).toBe(2);
    });
  });

  // ─── Install Logic ────────────────────────────────────────────────

  describe("install logic", () => {
    test("copies new binary to target directory", async () => {
      const sourceDir = join(testDir, "source");
      const targetDir = join(testDir, "target");
      await Bun.write(join(sourceDir, ".keep"), "");
      await Bun.write(join(targetDir, ".keep"), "");

      const newBinaryPath = join(sourceDir, "fossclaw-darwin-arm64");
      await writeFile(newBinaryPath, "new-binary-content");

      // Simulate install: copy new binary
      const binaryName = "fossclaw-darwin-arm64";
      const targetBinaryPath = join(targetDir, binaryName);
      const content = await readFile(newBinaryPath);
      await writeFile(targetBinaryPath, content);
      await chmod(targetBinaryPath, 0o755);

      expect(existsSync(targetBinaryPath)).toBe(true);
      const installed = await readFile(targetBinaryPath, "utf-8");
      expect(installed).toBe("new-binary-content");

      const stats = await stat(targetBinaryPath);
      expect(stats.mode & 0o755).toBe(0o755);
    });

    test("copies .bin file when present", async () => {
      const sourceDir = join(testDir, "source");
      const targetDir = join(testDir, "target");
      await Bun.write(join(sourceDir, ".keep"), "");
      await Bun.write(join(targetDir, ".keep"), "");

      await writeFile(join(sourceDir, "fossclaw-linux-arm64"), "wrapper");
      await writeFile(join(sourceDir, "fossclaw-linux-arm64.bin"), "bin-data");

      // Simulate install
      const wrapperContent = await readFile(join(sourceDir, "fossclaw-linux-arm64"));
      await writeFile(join(targetDir, "fossclaw-linux-arm64"), wrapperContent);
      const binContent = await readFile(join(sourceDir, "fossclaw-linux-arm64.bin"));
      await writeFile(join(targetDir, "fossclaw-linux-arm64.bin"), binContent);

      expect(await readFile(join(targetDir, "fossclaw-linux-arm64"), "utf-8")).toBe("wrapper");
      expect(await readFile(join(targetDir, "fossclaw-linux-arm64.bin"), "utf-8")).toBe("bin-data");
    });
  });

  // ─── Binary Discovery ────────────────────────────────────────────

  describe("binary discovery for restart", () => {
    const KNOWN_BINARIES = [
      "fossclaw-darwin-arm64",
      "fossclaw-darwin-x64",
      "fossclaw-linux-arm64",
      "fossclaw-linux-x64",
    ];

    function findBinary(dir: string): string | null {
      for (const file of KNOWN_BINARIES) {
        const path = join(dir, file);
        if (existsSync(path)) return path;
      }
      return null;
    }

    test("finds darwin-arm64 binary", async () => {
      await writeFile(join(testDir, "fossclaw-darwin-arm64"), "binary");
      const found = findBinary(testDir);
      expect(found).toBe(join(testDir, "fossclaw-darwin-arm64"));
    });

    test("finds linux-x64 binary", async () => {
      await writeFile(join(testDir, "fossclaw-linux-x64"), "binary");
      const found = findBinary(testDir);
      expect(found).toBe(join(testDir, "fossclaw-linux-x64"));
    });

    test("returns null when no binary exists", () => {
      const found = findBinary(testDir);
      expect(found).toBeNull();
    });

    test("prefers darwin-arm64 when multiple exist (first in list)", async () => {
      await writeFile(join(testDir, "fossclaw-darwin-arm64"), "mac");
      await writeFile(join(testDir, "fossclaw-linux-x64"), "linux");
      const found = findBinary(testDir);
      expect(found).toBe(join(testDir, "fossclaw-darwin-arm64"));
    });
  });

  // ─── Process Wait Logic ──────────────────────────────────────────

  describe("process wait logic", () => {
    test("detects non-existent process immediately", async () => {
      // PID 99999999 almost certainly doesn't exist
      let exited = false;
      try {
        process.kill(99999999, 0);
      } catch {
        exited = true;
      }
      expect(exited).toBe(true);
    });

    test("detects current process as alive", () => {
      // Our own PID should be alive
      let alive = false;
      try {
        process.kill(process.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
    });
  });
});
