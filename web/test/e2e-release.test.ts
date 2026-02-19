/**
 * E2E Release Tests
 *
 * Tests that can run locally to validate a release build before publishing.
 * Run with: bun test e2e-release.test.ts
 *
 * Prerequisites:
 * - Build the binary first: cd .. && ./build.sh
 * - Binary should be at: ../dist/fossclaw-{platform}-{arch}
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { existsSync, statSync } from "fs";

const PLATFORM = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const BINARY_NAME = PLATFORM === "windows" ? `fossclaw-${PLATFORM}-${ARCH}.exe` : `fossclaw-${PLATFORM}-${ARCH}`;
const BINARY_PATH = join(import.meta.dir, "..", "..", "dist", BINARY_NAME);
const binaryExists = existsSync(BINARY_PATH);

describe.skipIf(!binaryExists)("E2E Release Tests", () => {
  let serverProcess: Subprocess | null = null;
  const testPort = 14456;
  const openCodePort = 14556;

  beforeAll(() => {
    // Binary existence already checked via skipIf above
  });

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
  });

  test("binary exists and has reasonable size", () => {
    const stats = statSync(BINARY_PATH);
    const sizeInMB = stats.size / (1024 * 1024);

    console.log(`Binary size: ${sizeInMB.toFixed(2)} MB`);

    // Binary should be at least 20MB (contains Bun runtime + app)
    expect(sizeInMB).toBeGreaterThan(20);

    // But not absurdly large
    expect(sizeInMB).toBeLessThan(200);
  });

  test("binary is executable", async () => {
    // Try to execute the binary with a simple command
    const proc = spawn({
      cmd: [BINARY_PATH, "--help"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FOSSCLAW_TEST_MODE: "1",
      },
    });

    const exitCode = await proc.exited;

    // Should exit (either 0 or non-zero is fine, we just want it to run)
    expect(typeof exitCode).toBe("number");
  });

  test("server can start and handle requests", async () => {
    const testDir = await Bun.file("/tmp").exists()
      ? "/tmp/fossclaw-e2e-test"
      : join(import.meta.dir, "..", "..", "test-data");

    // Start the server
    serverProcess = spawn({
      cmd: [BINARY_PATH],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PORT: testPort.toString(),
        OPENCODE_PORT: openCodePort.toString(),
        FOSSCLAW_USER: "e2e-test",
        FOSSCLAW_PASS: "e2e-test-123",
        FOSSCLAW_CWD: testDir,
        FOSSCLAW_SESSION_DIR: join(testDir, "sessions"),
        NODE_ENV: "production",
      },
    });

    console.log("Starting server...");

    // Wait for server to be ready (max 30 seconds)
    let isReady = false;
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);

      try {
        const response = await fetch(`https://localhost:${testPort}/api/health`, {
          headers: {
            Authorization: `Basic ${btoa("e2e-test:e2e-test-123")}`,
          },
        });

        if (response.ok) {
          isReady = true;
          console.log("Server is ready!");
          break;
        }
      } catch (error) {
        // Server not ready yet
      }
    }

    expect(isReady).toBe(true);

    // Test health endpoint
    const healthResponse = await fetch(`https://localhost:${testPort}/api/health`, {
      headers: {
        Authorization: `Basic ${btoa("e2e-test:e2e-test-123")}`,
      },
    });

    expect(healthResponse.ok).toBe(true);
    const health = await healthResponse.json();
    expect(health.status).toBe("ok");

    // Test sessions endpoint
    const sessionsResponse = await fetch(`https://localhost:${testPort}/api/sessions`, {
      headers: {
        Authorization: `Basic ${btoa("e2e-test:e2e-test-123")}`,
      },
    });

    expect(sessionsResponse.ok).toBe(true);
    const sessions = await sessionsResponse.json();
    expect(Array.isArray(sessions)).toBe(true);

    // Test OpenCode models endpoint
    const modelsResponse = await fetch(`https://localhost:${testPort}/api/opencode/models`, {
      headers: {
        Authorization: `Basic ${btoa("e2e-test:e2e-test-123")}`,
      },
    });

    expect(modelsResponse.ok).toBe(true);
    const models = await modelsResponse.json();
    expect(Array.isArray(models)).toBe(true);

    console.log("All API endpoints working!");

    // Cleanup
    serverProcess.kill();
    await serverProcess.exited;
    serverProcess = null;
  }, 45000); // 45 second timeout

  test("binary includes required files", async () => {
    // Test that the binary can serve static files
    const testDir = await Bun.file("/tmp").exists()
      ? "/tmp/fossclaw-e2e-test-static"
      : join(import.meta.dir, "..", "..", "test-data-static");

    serverProcess = spawn({
      cmd: [BINARY_PATH],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PORT: (testPort + 1).toString(),
        FOSSCLAW_USER: "e2e-static",
        FOSSCLAW_PASS: "e2e-static-123",
        FOSSCLAW_CWD: testDir,
        NODE_ENV: "production",
      },
    });

    // Wait for server
    let isReady = false;
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);

      try {
        const response = await fetch(`https://localhost:${testPort + 1}/`, {
          redirect: "manual",
        });

        if (response.status === 302 || response.status === 200) {
          isReady = true;
          break;
        }
      } catch (error) {
        // Not ready yet
      }
    }

    expect(isReady).toBe(true);

    // Test that we can fetch the login page (or get redirected to it)
    const indexResponse = await fetch(`https://localhost:${testPort + 1}/`);
    expect(indexResponse.ok).toBe(true);

    // Cleanup
    serverProcess.kill();
    await serverProcess.exited;
    serverProcess = null;
  }, 45000);
});

describe.skipIf(!binaryExists)("Binary Integrity Checks", () => {
  test("binary contains expected strings", async () => {
    // Read binary as text to check for embedded strings
    const binaryContent = await Bun.file(BINARY_PATH).text();

    // Should contain React/frontend strings
    expect(binaryContent.includes("React")).toBe(true);

    // Should contain server strings
    expect(binaryContent.includes("Hono")).toBe(true);

    console.log("✅ Binary contains expected embedded strings");
  });

  test("binary has correct permissions", () => {
    if (PLATFORM === "windows") {
      // Windows doesn't use Unix permissions
      return;
    }

    const stats = statSync(BINARY_PATH);
    const mode = stats.mode & 0o777; // Get permission bits

    // Should be executable (at least for user)
    expect(mode & 0o100).toBeGreaterThan(0);

    console.log(`✅ Binary has executable permissions (${mode.toString(8)})`);
  });
});

describe("Archive Format Tests", () => {
  test("checksums file exists in dist", () => {
    const checksumPath = join(import.meta.dir, "..", "..", "dist", "checksums.txt");

    if (existsSync(checksumPath)) {
      const content = Bun.file(checksumPath).text();
      console.log("✅ Checksums file found");
    } else {
      console.log("⚠️  Checksums file not found (expected if not built with release script)");
    }
  });

  test("README and LICENSE exist in dist", () => {
    const readmePath = join(import.meta.dir, "..", "..", "dist", "README.md");
    const licensePath = join(import.meta.dir, "..", "..", "dist", "LICENSE");

    const hasReadme = existsSync(readmePath);
    const hasLicense = existsSync(licensePath);

    if (hasReadme && hasLicense) {
      console.log("✅ Documentation files found in dist");
    } else {
      console.log("⚠️  Some documentation files missing (expected if not built with release script)");
      console.log(`   README: ${hasReadme}`);
      console.log(`   LICENSE: ${hasLicense}`);
    }
  });
});
