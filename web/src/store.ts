import { create } from "zustand";
import type { SessionState, PermissionRequest, ChatMessage, SdkSessionInfo, TaskItem, LinearIssue, Playbook, CronJob } from "./types.js";

interface AppState {
  // Sessions
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;

  // Messages per session
  messages: Map<string, ChatMessage[]>;

  // Streaming partial text per session
  streaming: Map<string, string>;

  // Streaming stats: start time + output tokens
  streamingStartedAt: Map<string, number>;
  streamingOutputTokens: Map<string, number>;

  // Pending permissions per session (outer key = sessionId, inner key = request_id)
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;

  // Connection state per session
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;

  // Session status
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;

  // Session context (token usage for OpenCode sessions)
  sessionContext: Map<string, { used: number; max: number }>;

  // Plan mode: stores previous permission mode per session so we can restore it
  previousPermissionMode: Map<string, string>;

  // Tasks per session
  sessionTasks: Map<string, TaskItem[]>;

  // Session display names
  sessionNames: Map<string, string>;

  // Linear
  sidebarTab: "sessions" | "linear";
  linearIssues: LinearIssue[];
  linearSelectedIssue: LinearIssue | null;
  linearLoading: boolean;
  linearError: string | null;

  // Playbooks
  playbooks: Playbook[];

  // Prefill (from Linear issue + playbook)
  prefilledText: string | null;
  prefilledIssue: LinearIssue | null;

  // UI
  darkMode: boolean;
  colorTheme: "aurora" | "ocean" | "sunset" | "forest" | "lavender" | "rose";
  sidebarOpen: boolean;
  sidebarWidth: number;
  taskPanelOpen: boolean;
  showPlaybookManager: boolean;
  showKeyboardShortcuts: boolean;
  showSettings: boolean;
  notificationsEnabled: boolean;
  webhookUrl: string;
  appUrl: string;
  ollamaUrl: string;
  ollamaModel: string;
  homeResetKey: number;
  homeProvider: "claude" | "opencode";
  coderMode: boolean;
  recentDirs: string[];
  defaultModels: Map<"claude" | "opencode", string>;

  // Cron Jobs
  cronJobs: CronJob[];
  showCronPanel: boolean;

  // Actions
  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setColorTheme: (theme: "aurora" | "ocean" | "sunset" | "forest" | "lavender" | "rose") => void;
  setSidebarOpen: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setTaskPanelOpen: (open: boolean) => void;
  setShowPlaybookManager: (open: boolean) => void;
  setShowKeyboardShortcuts: (open: boolean) => void;
  setShowSettings: (open: boolean) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setWebhookUrl: (url: string) => void;
  setAppUrl: (url: string) => void;
  setOllamaUrl: (url: string) => void;
  setOllamaModel: (model: string) => void;
  setCoderMode: (enabled: boolean) => void;
  toggleCoderMode: () => void;
  newSession: (provider?: "claude" | "opencode") => void;

  // Linear actions
  setSidebarTab: (tab: "sessions" | "linear") => void;
  setLinearIssues: (issues: LinearIssue[]) => void;
  setLinearSelectedIssue: (issue: LinearIssue | null) => void;
  setLinearLoading: (loading: boolean) => void;
  setLinearError: (error: string | null) => void;

  // Playbook actions
  addPlaybook: (playbook: Playbook) => void;
  updatePlaybook: (id: string, updates: Partial<Playbook>) => void;
  deletePlaybook: (id: string) => void;

  // Prefill actions
  setPrefilledText: (text: string | null) => void;
  setPrefilledIssue: (issue: LinearIssue | null) => void;
  clearPrefill: () => void;

  // Cron actions
  setCronJobs: (jobs: CronJob[]) => void;
  setShowCronPanel: (open: boolean) => void;

  // Preferences
  loadPreferences: () => Promise<void>;
  addRecentDir: (dir: string) => void;
  setDefaultModel: (provider: "claude" | "opencode", model: string) => void;

  // Session actions
  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;

  // Message actions
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
  updateLastAssistantMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreaming: (sessionId: string, text: string | null) => void;
  setStreamingStats: (sessionId: string, stats: { startedAt?: number; outputTokens?: number } | null) => void;

  // Permission actions
  addPermission: (sessionId: string, perm: PermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;

  // Task actions
  addTask: (sessionId: string, task: TaskItem) => void;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  updateTask: (sessionId: string, taskId: string, updates: Partial<TaskItem>) => void;

  // Session name actions
  setSessionName: (sessionId: string, name: string) => void;
  setSessionNameLocal: (sessionId: string, name: string) => void;

  // Plan mode actions
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;

  // Connection actions
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;
  setSessionContext: (sessionId: string, context: { used: number; max: number } | null) => void;

  reset: () => void;
}

function getInitialSessionNames(): Map<string, string> {
  // Session names are loaded from the server via API polling
  return new Map();
}

function getInitialPlaybooks(): Playbook[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem("cc-playbooks") || "[]");
  } catch {
    return [];
  }
}

function getInitialDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-dark-mode");
  if (stored !== null) return stored === "true";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialColorTheme(): "aurora" | "ocean" | "sunset" | "forest" | "lavender" | "rose" {
  if (typeof window === "undefined") return "aurora";
  const stored = localStorage.getItem("cc-color-theme");
  if (stored && ["aurora", "ocean", "sunset", "forest", "lavender", "rose"].includes(stored)) {
    return stored as "aurora" | "ocean" | "sunset" | "forest" | "lavender" | "rose";
  }
  return "aurora";
}

export const useStore = create<AppState>((set) => ({
  sessions: new Map(),
  sdkSessions: [],
  currentSessionId: null,
  messages: new Map(),
  streaming: new Map(),
  streamingStartedAt: new Map(),
  streamingOutputTokens: new Map(),
  pendingPermissions: new Map(),
  connectionStatus: new Map(),
  cliConnected: new Map(),
  sessionStatus: new Map(),
  sessionContext: new Map(),
  previousPermissionMode: new Map(),
  sessionTasks: new Map(),
  sessionNames: getInitialSessionNames(),
  sidebarTab: "sessions",
  linearIssues: [],
  linearSelectedIssue: null,
  linearLoading: false,
  linearError: null,
  playbooks: getInitialPlaybooks(),
  prefilledText: null,
  prefilledIssue: null,
  darkMode: getInitialDarkMode(),
  colorTheme: getInitialColorTheme(),
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
  sidebarWidth: (() => {
    if (typeof window === "undefined") return 260;
    try {
      const stored = localStorage.getItem("cc-sidebar-width");
      if (stored) return Math.max(200, Math.min(600, Number(stored)));
    } catch {}
    return 260;
  })(),
  taskPanelOpen: typeof window !== "undefined" ? window.innerWidth >= 1024 : false,
  showPlaybookManager: false,
  showKeyboardShortcuts: false,
  showSettings: false,
  notificationsEnabled: false,
  webhookUrl: "",
  appUrl: "",
  ollamaUrl: "",
  ollamaModel: "",
  homeResetKey: 0,
  homeProvider: "claude",
  coderMode: false,
  recentDirs: (() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem("cc-recent-dirs") || "[]"); }
    catch { return []; }
  })(),
  defaultModels: (() => {
    if (typeof window === "undefined") return new Map();
    try {
      const stored = localStorage.getItem("cc-default-models");
      if (!stored) return new Map();
      const obj = JSON.parse(stored);
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  })(),

  // Cron Jobs
  cronJobs: [],
  showCronPanel: false,

  // Cron actions
  setCronJobs: (jobs) => set({ cronJobs: jobs }),
  setShowCronPanel: (open) => set({ showCronPanel: open }),

  setDarkMode: (v) => {
    localStorage.setItem("cc-dark-mode", String(v));
    set({ darkMode: v });
    import("./api.js").then(({ api }) => api.updatePreferences({ darkMode: v }).catch(() => {}));
  },
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("cc-dark-mode", String(next));
      import("./api.js").then(({ api }) => api.updatePreferences({ darkMode: next }).catch(() => {}));
      return { darkMode: next };
    }),
  setColorTheme: (theme) => {
    localStorage.setItem("cc-color-theme", theme);
    set({ colorTheme: theme });
    import("./api.js").then(({ api }) => api.updatePreferences({ colorTheme: theme }).catch(() => {}));
  },
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setSidebarWidth: (w) => {
    const clamped = Math.max(200, Math.min(600, w));
    localStorage.setItem("cc-sidebar-width", String(clamped));
    set({ sidebarWidth: clamped });
    // Debounce server sync (resize fires on every mouse move)
    clearTimeout((globalThis as any).__sidebarWidthTimer);
    (globalThis as any).__sidebarWidthTimer = setTimeout(() => {
      import("./api.js").then(({ api }) => api.updatePreferences({ sidebarWidth: clamped }).catch(() => {}));
    }, 500);
  },
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  setShowPlaybookManager: (open) => set({ showPlaybookManager: open }),
  setShowKeyboardShortcuts: (open) => set({ showKeyboardShortcuts: open }),
  setShowSettings: (open) => set({ showSettings: open }),
  setNotificationsEnabled: (enabled) => {
    set({ notificationsEnabled: enabled });
    import("./api.js").then(({ api }) => api.updatePreferences({ notificationsEnabled: enabled }).catch(() => {}));
  },
  setWebhookUrl: (url) => {
    set({ webhookUrl: url });
    import("./api.js").then(({ api }) => api.updatePreferences({ webhookUrl: url }).catch(() => {}));
  },
  setAppUrl: (url) => {
    set({ appUrl: url });
    import("./api.js").then(({ api }) => api.updatePreferences({ appUrl: url }).catch(() => {}));
  },
  setOllamaUrl: (url) => {
    set({ ollamaUrl: url });
    import("./api.js").then(({ api }) => api.updatePreferences({ ollamaUrl: url }).catch(() => {}));
  },
  setOllamaModel: (model) => {
    set({ ollamaModel: model });
    import("./api.js").then(({ api }) => api.updatePreferences({ ollamaModel: model }).catch(() => {}));
  },
  setCoderMode: (enabled) => set({ coderMode: enabled }),
  toggleCoderMode: () => set((s) => ({ coderMode: !s.coderMode })),
  newSession: (provider?: "claude" | "opencode") => set((s) => ({ 
    currentSessionId: null, 
    homeResetKey: s.homeResetKey + 1,
    homeProvider: provider ?? "claude",
    coderMode: provider === "opencode" ? true : s.coderMode,
  })),

  // Load preferences from server (called on mount)
  loadPreferences: async () => {
    try {
      const { api } = await import("./api.js");
      const prefs = await api.getPreferences() as Record<string, unknown>;
      const updates: Partial<AppState> = {};
      if (typeof prefs.darkMode === "boolean") {
        updates.darkMode = prefs.darkMode;
        localStorage.setItem("cc-dark-mode", String(prefs.darkMode));
      }
      if (typeof prefs.colorTheme === "string") {
        updates.colorTheme = prefs.colorTheme as AppState["colorTheme"];
        localStorage.setItem("cc-color-theme", prefs.colorTheme);
      }
      if (typeof prefs.sidebarWidth === "number") {
        updates.sidebarWidth = prefs.sidebarWidth;
        localStorage.setItem("cc-sidebar-width", String(prefs.sidebarWidth));
      }
      if (Array.isArray(prefs.playbooks)) {
        updates.playbooks = prefs.playbooks;
        localStorage.setItem("cc-playbooks", JSON.stringify(prefs.playbooks));
      }
      if (Array.isArray(prefs.recentDirs)) {
        updates.recentDirs = prefs.recentDirs;
        localStorage.setItem("cc-recent-dirs", JSON.stringify(prefs.recentDirs));
      }
      if (typeof prefs.webhookUrl === "string") {
        updates.webhookUrl = prefs.webhookUrl;
      }
      if (typeof prefs.notificationsEnabled === "boolean") {
        updates.notificationsEnabled = prefs.notificationsEnabled;
      }
      if (typeof prefs.appUrl === "string") {
        updates.appUrl = prefs.appUrl;
      }
      if (typeof prefs.ollamaUrl === "string") {
        updates.ollamaUrl = prefs.ollamaUrl;
      }
      if (typeof prefs.ollamaModel === "string") {
        updates.ollamaModel = prefs.ollamaModel;
      }
      if (prefs.defaultModels && typeof prefs.defaultModels === "object") {
        const validEntries = Object.entries(prefs.defaultModels).filter(
          ([key]) => key === "claude" || key === "opencode"
        );
        updates.defaultModels = new Map(validEntries as ["claude" | "opencode", string][]);
        localStorage.setItem("cc-default-models", JSON.stringify(prefs.defaultModels));
      }
      set(updates);
    } catch {
      // Server unavailable; localStorage cache values are fine
    }
  },

  addRecentDir: (dir) => {
    set((s) => {
      const dirs = s.recentDirs.filter((d) => d !== dir);
      dirs.unshift(dir);
      const trimmed = dirs.slice(0, 5);
      localStorage.setItem("cc-recent-dirs", JSON.stringify(trimmed));
      import("./api.js").then(({ api }) => api.updatePreferences({ recentDirs: trimmed }).catch(() => {}));
      return { recentDirs: trimmed };
    });
  },

  setDefaultModel: (provider, model) => {
    set((s) => {
      const defaultModels = new Map(s.defaultModels);
      defaultModels.set(provider, model);
      const obj = Object.fromEntries(defaultModels);
      localStorage.setItem("cc-default-models", JSON.stringify(obj));
      import("./api.js").then(({ api }) => api.updatePreferences({ defaultModels: obj }).catch(() => {}));
      return { defaultModels };
    });
  },

  // Linear actions
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setLinearIssues: (issues) => set({ linearIssues: issues }),
  setLinearSelectedIssue: (issue) => set({ linearSelectedIssue: issue }),
  setLinearLoading: (loading) => set({ linearLoading: loading }),
  setLinearError: (error) => set({ linearError: error }),

  // Playbook actions
  addPlaybook: (playbook) =>
    set((s) => {
      const playbooks = [...s.playbooks, playbook];
      localStorage.setItem("cc-playbooks", JSON.stringify(playbooks));
      import("./api.js").then(({ api }) => api.updatePreferences({ playbooks }).catch(() => {}));
      return { playbooks };
    }),
  updatePlaybook: (id, updates) =>
    set((s) => {
      const playbooks = s.playbooks.map((pb) => (pb.id === id ? { ...pb, ...updates } : pb));
      localStorage.setItem("cc-playbooks", JSON.stringify(playbooks));
      import("./api.js").then(({ api }) => api.updatePreferences({ playbooks }).catch(() => {}));
      return { playbooks };
    }),
  deletePlaybook: (id) =>
    set((s) => {
      const playbooks = s.playbooks.filter((pb) => pb.id !== id);
      localStorage.setItem("cc-playbooks", JSON.stringify(playbooks));
      import("./api.js").then(({ api }) => api.updatePreferences({ playbooks }).catch(() => {}));
      return { playbooks };
    }),

  // Prefill actions
  setPrefilledText: (text) => set({ prefilledText: text }),
  setPrefilledIssue: (issue) => set({ prefilledIssue: issue }),
  clearPrefill: () => set({ prefilledText: null, prefilledIssue: null, linearSelectedIssue: null }),

  setCurrentSession: (id) => set({ currentSessionId: id }),

  addSession: (session) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(session.session_id, session);
      const messages = new Map(s.messages);
      if (!messages.has(session.session_id)) messages.set(session.session_id, []);
      return { sessions, messages };
    }),

  updateSession: (sessionId, updates) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...updates });
      return { sessions };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.delete(sessionId);
      const messages = new Map(s.messages);
      messages.delete(sessionId);
      const streaming = new Map(s.streaming);
      streaming.delete(sessionId);
      const streamingStartedAt = new Map(s.streamingStartedAt);
      streamingStartedAt.delete(sessionId);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      streamingOutputTokens.delete(sessionId);
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.delete(sessionId);
      const cliConnected = new Map(s.cliConnected);
      cliConnected.delete(sessionId);
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.delete(sessionId);
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.delete(sessionId);
      const pendingPermissions = new Map(s.pendingPermissions);
      pendingPermissions.delete(sessionId);
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.delete(sessionId);
      const sessionNames = new Map(s.sessionNames);
      sessionNames.delete(sessionId);
      return {
        sessions,
        messages,
        streaming,
        streamingStartedAt,
        streamingOutputTokens,
        connectionStatus,
        cliConnected,
        sessionStatus,
        previousPermissionMode,
        pendingPermissions,
        sessionTasks,
        sessionNames,
        sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      };
    }),

  setSdkSessions: (sessions) => set({ sdkSessions: sessions }),

  appendMessage: (sessionId, msg) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = [...(messages.get(sessionId) || []), msg];
      messages.set(sessionId, list);
      return { messages };
    }),

  setMessages: (sessionId, msgs) =>
    set((s) => {
      const messages = new Map(s.messages);
      messages.set(sessionId, msgs);
      return { messages };
    }),

  updateLastAssistantMessage: (sessionId, updater) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = [...(messages.get(sessionId) || [])];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant") {
          list[i] = updater(list[i]);
          break;
        }
      }
      messages.set(sessionId, list);
      return { messages };
    }),

  setStreaming: (sessionId, text) =>
    set((s) => {
      const streaming = new Map(s.streaming);
      if (text === null) {
        streaming.delete(sessionId);
      } else {
        streaming.set(sessionId, text);
      }
      return { streaming };
    }),

  setStreamingStats: (sessionId, stats) =>
    set((s) => {
      const streamingStartedAt = new Map(s.streamingStartedAt);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      if (stats === null) {
        streamingStartedAt.delete(sessionId);
        streamingOutputTokens.delete(sessionId);
      } else {
        if (stats.startedAt !== undefined) streamingStartedAt.set(sessionId, stats.startedAt);
        if (stats.outputTokens !== undefined) streamingOutputTokens.set(sessionId, stats.outputTokens);
      }
      return { streamingStartedAt, streamingOutputTokens };
    }),

  addPermission: (sessionId, perm) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = new Map(pendingPermissions.get(sessionId) || []);
      sessionPerms.set(perm.request_id, perm);
      pendingPermissions.set(sessionId, sessionPerms);
      return { pendingPermissions };
    }),

  removePermission: (sessionId, requestId) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const updated = new Map(sessionPerms);
        updated.delete(requestId);
        pendingPermissions.set(sessionId, updated);
      }
      return { pendingPermissions };
    }),

  addTask: (sessionId, task) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = [...(sessionTasks.get(sessionId) || []), task];
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  setTasks: (sessionId, tasks) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  updateTask: (sessionId, taskId, updates) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = sessionTasks.get(sessionId);
      if (tasks) {
        sessionTasks.set(
          sessionId,
          tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        );
      }
      return { sessionTasks };
    }),

  setSessionNameLocal: (sessionId, name) =>
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      return { sessionNames };
    }),

  setSessionName: (sessionId, name) => {
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      return { sessionNames };
    });
    // Persist to server (source of truth)
    import("./api.js").then(({ api }) => {
      api.updateSessionName(sessionId, name).catch((err) => {
        console.error("Failed to persist session name:", err);
      });
    });
  },

  setPreviousPermissionMode: (sessionId, mode) =>
    set((s) => {
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.set(sessionId, mode);
      return { previousPermissionMode };
    }),

  setConnectionStatus: (sessionId, status) =>
    set((s) => {
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),

  setCliConnected: (sessionId, connected) =>
    set((s) => {
      const cliConnected = new Map(s.cliConnected);
      cliConnected.set(sessionId, connected);
      return { cliConnected };
    }),

  setSessionStatus: (sessionId, status) =>
    set((s) => {
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.set(sessionId, status);
      return { sessionStatus };
    }),

  setSessionContext: (sessionId, context) =>
    set((s) => {
      const sessionContext = new Map(s.sessionContext);
      if (context === null) {
        sessionContext.delete(sessionId);
      } else {
        sessionContext.set(sessionId, context);
      }
      return { sessionContext };
    }),

  reset: () =>
    set({
      sessions: new Map(),
      sdkSessions: [],
      currentSessionId: null,
      messages: new Map(),
      streaming: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      pendingPermissions: new Map(),
      connectionStatus: new Map(),
      cliConnected: new Map(),
      sessionStatus: new Map(),
      sessionContext: new Map(),
      previousPermissionMode: new Map(),
      sessionTasks: new Map(),
      sessionNames: new Map(),
      linearIssues: [],
      linearSelectedIssue: null,
      linearLoading: false,
      linearError: null,
      prefilledText: null,
      prefilledIssue: null,
    }),
}));
