import type {
  SessionState,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
} from "../server/session-types.js";

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: { media_type: string; data: string }[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: string[];
}

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  provider?: "claude" | "opencode";
  cwd: string;
  createdAt: number;
  sessionName?: string;
  archived?: boolean; // Session restored from disk but CLI is dead (read-only)
}

export interface LinearIssue {
  identifier: string;
  title: string;
  description: string;
  state: string;
  priority: string;
  labels: string[];
  assignee: string | null;
  url: string;
  createdAt: string;
  cycle: string | null;
}

export interface Playbook {
  id: string;
  name: string;
  template: string;
  autoMapLabels: string[];
  description?: string;
}
