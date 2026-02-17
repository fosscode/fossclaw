import { resolve, dirname } from "node:path";
import { existsSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

interface GitHubRelease {
  tag_name: string;
  name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
  published_at: string;
}

export class UpdateChecker {
  private readonly githubRepo = "fosscode/fossclaw";
  private readonly currentVersion: string;
  private readonly platform: string;
  private readonly arch: string;
  private latestVersion?: string;
  private downloadUrl?: string;

  constructor(currentVersion: string) {
    this.currentVersion = currentVersion;
    this.platform = this.getPlatform();
    this.arch = this.getArch();
  }

  private getPlatform(): string {
    const platform = process.platform;
    if (platform === "darwin") return "darwin";
    if (platform === "linux") return "linux";
    if (platform === "win32") return "windows";
    throw new Error(`Unsupported platform: ${platform}`);
  }

  private getArch(): string {
    const arch = process.arch;
    if (arch === "arm64") return "arm64";
    if (arch === "x64") return "x64";
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  /**
   * Check if a new version is available on GitHub
   */
  async checkForUpdates(): Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion: string;
    downloadUrl?: string;
  }> {
    try {
      console.log("[updater] Checking for updates...");

      const response = await fetch(
        `https://api.github.com/repos/${this.githubRepo}/releases/latest`,
        {
          headers: {
            "User-Agent": "FossClaw-UpdateChecker",
            "Accept": "application/vnd.github.v3+json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}`);
      }

      const release: GitHubRelease = await response.json();
      this.latestVersion = release.tag_name.replace(/^v/, "");

      // Find the download URL for this platform
      const binaryName = this.getBinaryName();
      const asset = release.assets.find((a) => a.name === `${binaryName}.tar.gz`);
      this.downloadUrl = asset?.browser_download_url;

      const updateAvailable = this.isNewerVersion(this.latestVersion, this.currentVersion);

      if (updateAvailable) {
        console.log(`[updater] Update available: ${this.currentVersion} → ${this.latestVersion}`);
      } else {
        console.log(`[updater] Already on latest version: ${this.currentVersion}`);
      }

      return {
        updateAvailable,
        currentVersion: this.currentVersion,
        latestVersion: this.latestVersion,
        downloadUrl: this.downloadUrl,
      };
    } catch (error) {
      console.error("[updater] Failed to check for updates:", error);
      return {
        updateAvailable: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
      };
    }
  }

  /**
   * Compare two semantic version strings
   */
  private isNewerVersion(latest: string, current: string): boolean {
    const latestParts = latest.split(".").map(Number);
    const currentParts = current.split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      const l = latestParts[i] || 0;
      const c = currentParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  /**
   * Download and install the update
   */
  async downloadAndInstall(): Promise<void> {
    if (!this.downloadUrl) {
      throw new Error("No download URL available");
    }

    console.log(`[updater] Downloading update v${this.latestVersion}...`);

    const tmpDir = resolve(homedir(), ".fossclaw", "tmp");

    // Ensure tmp directory exists
    if (!existsSync(tmpDir)) {
      await Bun.write(resolve(tmpDir, ".keep"), "");
    }

    const binaryName = this.getBinaryName();
    const tarballPath = resolve(tmpDir, `${binaryName}.tar.gz`);

    console.log(`[updater] Downloading from ${this.downloadUrl}...`);

    const response = await fetch(this.downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    await Bun.write(tarballPath, arrayBuffer);

    console.log(`[updater] Downloaded ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);

    // Extract the tarball
    console.log("[updater] Extracting update...");
    await this.extractTarball(tarballPath, tmpDir);

    // Apply the update
    console.log("[updater] Applying update...");
    await this.applyUpdate(tmpDir, binaryName);
  }

  private getBinaryName(): string {
    if (this.platform === "windows") {
      return `fossclaw-windows-${this.arch}`;
    }
    return `fossclaw-${this.platform}-${this.arch}`;
  }

  private async extractTarball(tarballPath: string, destDir: string): Promise<void> {
    const proc = spawn("tar", ["-xzf", tarballPath, "-C", destDir], {
      stdio: "inherit",
    });

    return new Promise((resolve, reject) => {
      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`tar extraction failed with code ${code}`));
        }
      });
      proc.on("error", reject);
    });
  }

  /**
   * Apply the update by spawning the updater helper
   */
  private async applyUpdate(tmpDir: string, binaryName: string): Promise<void> {
    const currentBinaryPath = process.argv[0];
    const currentBinaryDir = dirname(currentBinaryPath);

    const newBinaryPath = resolve(tmpDir, binaryName);
    const newBinaryBinPath = resolve(tmpDir, `${binaryName}.bin`);
    const newDistPath = resolve(tmpDir, "dist");

    if (!existsSync(newBinaryPath)) {
      throw new Error(`Downloaded binary not found at ${newBinaryPath}`);
    }

    // Build the updater helper
    const updaterPath = await this.buildUpdaterHelper();

    console.log("[updater] Starting update helper...");

    const args = [
      "--current-dir", currentBinaryDir,
      "--new-binary", newBinaryPath,
      "--new-binary-bin", newBinaryBinPath,
      "--new-dist", newDistPath,
      "--pid", process.pid.toString(),
    ];

    const proc = spawn(updaterPath, args, {
      detached: true,
      stdio: "inherit",
    });

    proc.unref();

    console.log("[updater] Update helper started, shutting down for update...");

    // Exit after a short delay
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }

  /**
   * Build the updater helper binary
   */
  private async buildUpdaterHelper(): Promise<string> {
    const helperSourcePath = resolve(__dirname, "updater-helper.ts");
    const helperBinaryPath = resolve(homedir(), ".fossclaw", "updater-helper");

    if (!existsSync(helperBinaryPath)) {
      console.log("[updater] Building updater helper...");

      const proc = spawn("bun", ["build", helperSourcePath, "--compile", "--outfile", helperBinaryPath], {
        stdio: "inherit",
      });

      await new Promise<void>((resolve, reject) => {
        proc.on("exit", (code) => {
          if (code === 0) {
            chmodSync(helperBinaryPath, 0o755);
            resolve();
          } else {
            reject(new Error(`Failed to build updater helper: exit code ${code}`));
          }
        });
        proc.on("error", reject);
      });
    }

    return helperBinaryPath;
  }
}
