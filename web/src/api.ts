import type { SdkSessionInfo, LinearIssue } from "./types.js";

const BASE = "/api";

async function post<T = unknown>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

async function del<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function patch<T = unknown>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  provider?: "claude" | "opencode";
  providerID?: string;
  cwd?: string;
  claudeBinary?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
}

export interface OpenCodeModel {
  id: string;
  name: string;
  providerID: string;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListResult {
  path: string;
  dirs: DirEntry[];
  home: string;
  error?: string;
}

export const api = {
  // Auth
  getAuthStatus: () =>
    get<{ authEnabled: boolean }>("/auth/status"),

  login: (username: string, password: string) =>
    post<{ success: boolean }>("/auth/login", { username, password }),

  logout: () =>
    post<{ success: boolean }>("/auth/logout"),

  // Sessions
  createSession: (opts?: CreateSessionOpts) =>
    post<{ sessionId: string; state: string; cwd: string }>("/sessions/create", opts),

  listSessions: () =>
    get<SdkSessionInfo[]>("/sessions"),

  killSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}`),

  updateSessionName: (sessionId: string, name: string) =>
    patch<{ ok: boolean; sessionName: string }>(`/sessions/${encodeURIComponent(sessionId)}/name`, { name }),

  resumeSession: (sessionId: string) =>
    post<{ ok: boolean; newSessionId: string; oldSessionId: string }>(`/sessions/${encodeURIComponent(sessionId)}/resume`),

  listDirs: (path?: string) =>
    get<DirListResult>(`/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  getHome: () =>
    get<{ home: string; cwd: string }>("/fs/home"),

  // OpenCode
  listOpenCodeModels: () =>
    get<{ models: OpenCodeModel[] }>("/opencode/models"),

  getSessionContext: (sessionId: string) =>
    get<{ tokens?: { used: number; max: number }; error?: string }>(`/sessions/${encodeURIComponent(sessionId)}/context`),

  // Linear
  listLinearIssues: (params?: {
    q?: string;
    team?: string;
    assignedToMe?: boolean;
    assignee?: string;
    state?: string;
    labels?: string[];
    cycle?: string;
    createdAfter?: string;
    subscribedByMe?: boolean;
    includeCompleted?: boolean;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params?.q) query.set("q", params.q);
    if (params?.team) query.set("team", params.team);
    if (params?.assignedToMe) query.set("assignedToMe", "true");
    if (params?.assignee) query.set("assignee", params.assignee);
    if (params?.state) query.set("state", params.state);
    if (params?.labels?.length) query.set("labels", params.labels.join(","));
    if (params?.cycle) query.set("cycle", params.cycle);
    if (params?.createdAfter) query.set("createdAfter", params.createdAfter);
    if (params?.subscribedByMe) query.set("subscribedByMe", "true");
    if (params?.includeCompleted) query.set("includeCompleted", "true");
    if (params?.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return get<{ issues: LinearIssue[] }>(`/linear/issues${qs ? `?${qs}` : ""}`);
  },

  getLinearIssue: (id: string) =>
    get<LinearIssue>(`/linear/issues/${encodeURIComponent(id)}`),

  listLinearTeams: () =>
    get<{ teams: { id: string; key: string; name: string }[] }>("/linear/teams"),

  listLinearLabels: (team?: string) =>
    get<{ labels: { id: string; name: string; color: string }[] }>(
      `/linear/labels${team ? `?team=${encodeURIComponent(team)}` : ""}`,
    ),

  listLinearCycles: (team: string) =>
    get<{ cycles: { id: string; number: number; name: string | null; startsAt: string; endsAt: string }[] }>(
      `/linear/cycles?team=${encodeURIComponent(team)}`,
    ),

  listLinearStates: (team: string) =>
    get<{ states: { id: string; name: string; color: string; type: string }[] }>(
      `/linear/states?team=${encodeURIComponent(team)}`,
    ),

  listLinearMembers: (team: string) =>
    get<{ members: { id: string; name: string }[] }>(
      `/linear/members?team=${encodeURIComponent(team)}`,
    ),

  // Preferences
  getPreferences: () =>
    get<Record<string, unknown>>("/preferences"),

  updatePreferences: (prefs: Record<string, unknown>) =>
    patch<Record<string, unknown>>("/preferences", prefs),

  // Claude session resumption
  listClaudeSessions: () =>
    get<{ sessions: Array<{ sessionId: string; cwd: string; lastModified: number }> }>("/claude-sessions"),

  // Updates
  checkForUpdates: () =>
    get<{
      updateAvailable: boolean;
      currentVersion: string;
      latestVersion: string;
      downloadUrl?: string;
    }>("/updates/check"),

  installUpdate: () =>
    post<{ success: boolean; message: string }>("/updates/install"),
};
