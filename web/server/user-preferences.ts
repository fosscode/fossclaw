import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface Playbook {
  id: string;
  name: string;
  template: string;
  autoMapLabels: string[];
  description?: string;
}

export interface UserPreferences {
  darkMode: boolean;
  colorTheme: "aurora" | "ocean" | "sunset" | "forest" | "lavender" | "rose";
  sidebarWidth: number;
  playbooks: Playbook[];
  recentDirs: string[];
}

const DEFAULTS: UserPreferences = {
  darkMode: false,
  colorTheme: "aurora",
  sidebarWidth: 260,
  playbooks: [],
  recentDirs: [],
};

export class UserPreferencesStore {
  private filePath: string;
  private cached: UserPreferences | null = null;
  private pending: Partial<UserPreferences> | null = null;
  private timer: Timer | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath || join(homedir(), ".fossclaw", "preferences.json");
  }

  async load(): Promise<UserPreferences> {
    if (this.cached) {
      return { ...this.cached, ...(this.pending || {}) };
    }
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.cached = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      this.cached = { ...DEFAULTS };
    }
    return { ...this.cached, ...(this.pending || {}) };
  }

  save(updates: Partial<UserPreferences>): void {
    if (!this.pending) {
      this.pending = {};
    }
    Object.assign(this.pending, updates);
    // Update cached immediately
    if (this.cached) {
      Object.assign(this.cached, updates);
    }
    this.debounce();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    await this.writeToDisk();
  }

  private debounce(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.writeToDisk(), 500);
  }

  private async writeToDisk(): Promise<void> {
    if (!this.pending) return;
    // Merge pending into cached
    const current = this.cached || { ...DEFAULTS };
    Object.assign(current, this.pending);
    this.cached = current;
    this.pending = null;

    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = this.filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(current, null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }
}
