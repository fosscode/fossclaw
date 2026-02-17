#!/usr/bin/env bun
/**
 * FossClaw Updater Helper
 *
 * This is a small standalone binary that handles the actual update process.
 * It waits for the main FossClaw process to exit, then swaps the binaries
 * and restarts the application.
 */

import { resolve } from "node:path";
import { existsSync, renameSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";

interface UpdateArgs {
  currentDir: string;
  newBinary: string;
  newBinaryBin: string;
  newDist: string;
  pid: number;
}

function parseArgs(): UpdateArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<UpdateArgs> = {};

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

  if (!parsed.currentDir || !parsed.newBinary || !parsed.pid) {
    console.error("Usage: updater-helper --current-dir <dir> --new-binary <path> --new-binary-bin <path> --new-dist <path> --pid <pid>");
    process.exit(1);
  }

  return parsed as UpdateArgs;
}

async function waitForProcessExit(pid: number, maxWaitSeconds = 30): Promise<void> {
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  console.log(`[updater-helper] Waiting for process ${pid} to exit...`);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Send signal 0 to check if process exists
      process.kill(pid, 0);
      // Process still running, wait a bit
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // Process has exited
      console.log(`[updater-helper] Process ${pid} has exited`);
      return;
    }
  }

  throw new Error(`Process ${pid} did not exit within ${maxWaitSeconds} seconds`);
}

function backupCurrentBinary(currentDir: string): void {
  const files = ["fossclaw-darwin-arm64", "fossclaw-darwin-x64", "fossclaw-linux-arm64", "fossclaw-linux-x64"];

  for (const file of files) {
    const path = resolve(currentDir, file);
    const binPath = resolve(currentDir, `${file}.bin`);
    const backupPath = resolve(currentDir, `${file}.backup`);
    const backupBinPath = resolve(currentDir, `${file}.bin.backup`);

    if (existsSync(path)) {
      console.log(`[updater-helper] Backing up ${file}...`);
      copyFileSync(path, backupPath);

      if (existsSync(binPath)) {
        copyFileSync(binPath, backupBinPath);
      }
    }
  }
}

function installUpdate(args: UpdateArgs): void {
  const { currentDir, newBinary, newBinaryBin, newDist } = args;

  console.log("[updater-helper] Installing update...");

  // Backup current binary
  backupCurrentBinary(currentDir);

  // Get the binary name from the path
  const binaryName = newBinary.split("/").pop()!;
  const targetBinaryPath = resolve(currentDir, binaryName);
  const targetBinaryBinPath = resolve(currentDir, `${binaryName}.bin`);
  const targetDistPath = resolve(currentDir, "dist");

  // Copy new binary wrapper
  console.log(`[updater-helper] Installing new binary: ${binaryName}`);
  copyFileSync(newBinary, targetBinaryPath);
  chmodSync(targetBinaryPath, 0o755);

  // Copy new binary .bin file
  if (existsSync(newBinaryBin)) {
    console.log(`[updater-helper] Installing new binary: ${binaryName}.bin`);
    copyFileSync(newBinaryBin, targetBinaryBinPath);
    chmodSync(targetBinaryBinPath, 0o755);
  }

  // Replace dist folder
  if (existsSync(newDist)) {
    console.log("[updater-helper] Installing new dist folder...");
    if (existsSync(targetDistPath)) {
      rmSync(targetDistPath, { recursive: true, force: true });
    }
    // Copy recursively using cp command for simplicity
    const proc = Bun.spawnSync(["cp", "-r", newDist, targetDistPath]);
    if (!proc.success) {
      throw new Error("Failed to copy dist folder");
    }
  }

  console.log("[updater-helper] Update installed successfully");
}

function restartApplication(currentDir: string): void {
  // Find the binary to restart
  const files = ["fossclaw-darwin-arm64", "fossclaw-darwin-x64", "fossclaw-linux-arm64", "fossclaw-linux-x64"];

  for (const file of files) {
    const path = resolve(currentDir, file);
    if (existsSync(path)) {
      console.log(`[updater-helper] Restarting FossClaw: ${path}`);

      // Spawn the updated binary
      const proc = spawn(path, [], {
        detached: true,
        stdio: "ignore",
        cwd: currentDir,
      });

      proc.unref();

      console.log("[updater-helper] Update complete, application restarted");
      return;
    }
  }

  console.error("[updater-helper] Could not find binary to restart");
  process.exit(1);
}

async function main() {
  try {
    const args = parseArgs();

    // Wait for the main process to exit
    await waitForProcessExit(args.pid);

    // Install the update
    installUpdate(args);

    // Restart the application
    restartApplication(args.currentDir);

    process.exit(0);
  } catch (error) {
    console.error("[updater-helper] Update failed:", error);
    process.exit(1);
  }
}

main();
