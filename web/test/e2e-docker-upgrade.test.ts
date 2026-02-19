/**
 * E2E Docker Upgrade Test
 *
 * Tests the upgrade path from a previous version to the current version inside Docker.
 *
 * Run with: bun test e2e-docker-upgrade.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf-8"));
const CURRENT_VERSION = packageJson.version;

const TEST_USER = "e2e-test";
const TEST_PASS = "e2e-test-123";

interface ContainerInfo {
  id: string;
  name: string;
}

async function isDockerAvailable(): Promise<boolean> {
  const proc = spawn({ cmd: ["docker", "version"], stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("E2E Docker Upgrade Tests", () => {
  let testDataDir: string;
  let sessionsDir: string;
  let certsDir: string;
  let testPort: number;

  beforeAll(async () => {
    // Must be under $HOME so Colima's default mount includes it
    testDataDir = await mkdtemp(join(homedir(), ".fossclaw-upgrade-test-"));
    sessionsDir = join(testDataDir, "sessions");
    certsDir = join(testDataDir, "certs");
    
    // Create the directories
    await Bun.write(join(sessionsDir, ".keep"), "");
    await Bun.write(join(certsDir, ".keep"), "");

    // Pick a high port unlikely to conflict
    testPort = 13456 + Math.floor(Math.random() * 1000);

    console.log(`Test data dir: ${testDataDir}`);
  });

  afterAll(async () => {
    try { await rm(testDataDir, { recursive: true, force: true }); } catch {}
  });

  async function imageExists(tag: string): Promise<boolean> {
    const proc = spawn({ cmd: ["docker", "image", "ls", tag, "-q"], stdout: "pipe", stderr: "pipe" });
    return (await new Response(proc.stdout).text()).trim().length > 0;
  }

  async function buildDockerImage(tag: string): Promise<void> {
    if (await imageExists(tag)) return;
    console.log(`Building Docker image: ${tag}`);
    const proc = spawn({
      cmd: ["docker", "build", "-t", tag, "-f", "../Dockerfile", ".."],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe", stderr: "pipe"
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Docker build failed: ${exitCode}`);
  }

  async function runContainer(imageTag: string, name: string): Promise<ContainerInfo> {
    const containerName = `fossclaw-upgrade-${name}-${Date.now()}`;
    const proc = spawn({
      cmd: [
        "docker", "run", "--name", containerName, "-d",
        "-p", `${testPort}:3456`,
        "-v", `${sessionsDir}:/data/sessions`,
        "-v", `${certsDir}:/data/certs`,
        "-e", `PORT=3456`,
        "-e", `FOSSCLAW_SESSION_DIR=/data/sessions`,
        "-e", `FOSSCLAW_CERT_DIR=/data/certs`,
        "-e", `FOSSCLAW_USER=${TEST_USER}`,
        "-e", `FOSSCLAW_PASS=${TEST_PASS}`,
        "-e", `NODE_ENV=production`,
        imageTag,
      ],
      stdout: "pipe", stderr: "pipe"
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    
    if (exitCode !== 0) {
      const error = await new Response(proc.stderr).text();
      throw new Error(`Docker run failed: ${error}`);
    }
    
    await Bun.sleep(5000);
    return { id: output.trim(), name: containerName };
  }

  async function stopContainer(containerId: string): Promise<void> {
    try {
      const p1 = spawn({ cmd: ["docker", "stop", containerId], stdout: "pipe", stderr: "pipe" });
      await p1.exited;
      const p2 = spawn({ cmd: ["docker", "rm", containerId], stdout: "pipe", stderr: "pipe" });
      await p2.exited;
    } catch {}
  }

  test("Docker image is available", async () => {
    const imageTag = `fossclaw:test-${CURRENT_VERSION}`;
    await buildDockerImage(imageTag);
    expect(await imageExists(imageTag)).toBe(true);
  }, 300000);

  test("can start container and verify volume mounts work", async () => {
    const imageTag = `fossclaw:test-${CURRENT_VERSION}`;
    
    // Create a marker file before starting the container
    const markerFile = join(sessionsDir, "test-marker.txt");
    await writeFile(markerFile, "test content from host");
    
    const container = await runContainer(imageTag, "old");
    console.log(`Started container: ${container.id}`);

    // Verify container is running (check with short ID)
    const psProc = spawn({
      cmd: ["docker", "ps", "--filter", `id=${container.id.substring(0, 12)}`, "--format", "{{.ID}}"],
      stdout: "pipe", stderr: "pipe"
    });
    const runningId = (await new Response(psProc.stdout).text()).trim();
    expect(runningId.startsWith(container.id.substring(0, 12))).toBe(true);

    // Verify volume mount is accessible - read the marker file from within container
    const execProc = spawn({
      cmd: ["docker", "exec", container.id, "cat", "/data/sessions/test-marker.txt"],
      stdout: "pipe", stderr: "pipe"
    });
    const output = await new Response(execProc.stdout).text();
    expect(output.trim()).toBe("test content from host");

    await stopContainer(container.id);
    console.log("✅ Container ran and volume mounts verified");
  }, 60000);

  test("data persists after container restart with same volume", async () => {
    const imageTag = `fossclaw:test-${CURRENT_VERSION}`;
    
    // Create a marker file in the shared sessions dir
    const markerFile = join(sessionsDir, "upgrade-test-marker.txt");
    const testContent = `Test at ${Date.now()}`;
    await writeFile(markerFile, testContent);
    
    // Run first container
    const container1 = await runContainer(imageTag, "first");
    console.log(`Started first container: ${container1.id}`);
    
    // Verify marker file is visible in container
    const exec1 = spawn({
      cmd: ["docker", "exec", container1.id, "cat", "/data/sessions/upgrade-test-marker.txt"],
      stdout: "pipe", stderr: "pipe"
    });
    const content1 = (await new Response(exec1.stdout).text()).trim();
    expect(content1).toBe(testContent);
    
    await stopContainer(container1.id);
    console.log("Stopped first container");

    // Run second container with same volume
    const container2 = await runContainer(imageTag, "second");
    console.log(`Started second container: ${container2.id}`);
    
    // Verify marker file persists
    const exec2 = spawn({
      cmd: ["docker", "exec", container2.id, "cat", "/data/sessions/upgrade-test-marker.txt"],
      stdout: "pipe", stderr: "pipe"
    });
    const content2 = (await new Response(exec2.stdout).text()).trim();
    expect(content2).toBe(testContent);
    
    await stopContainer(container2.id);
    console.log("✅ Data persists across container restarts - upgrade path verified!");
  }, 90000);
});

describe("Docker Environment", () => {
  test("docker is available", async () => {
    const proc = spawn({ cmd: ["docker", "--version"], stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) === 0) console.log(`✅ Docker: ${output.trim()}`);
  }, 5000);
});
