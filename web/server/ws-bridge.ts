import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import type {
  CLIMessage,
  CLISystemInitMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIAuthStatusMessage,
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  SessionState,
  PermissionRequest,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { OllamaClient } from "./ollama-client.js";
import type { UserPreferencesStore } from "./user-preferences.js";

// ─── WebSocket data tags ──────────────────────────────────────────────────────

interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
}

export type SocketData = CLISocketData | BrowserSocketData;

// ─── Session ──────────────────────────────────────────────────────────────────

interface Session {
  id: string;
  cliSocket: ServerWebSocket<SocketData> | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
  /** Track if this is the first user message (for auto-naming) */
  firstMessageReceived: boolean;
  /** Archived sessions are read-only (CLI is dead) */
  archived?: boolean;
}

function makeDefaultState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
  };
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private sessions = new Map<string, Session>();
  private externalHandlers = new Map<string, (msg: Record<string, unknown>) => void>();
  private store: SessionStore | null;
  private ollama: OllamaClient | null;
  private prefsStore: UserPreferencesStore | null = null;
  public onActivity: ((sessionId: string) => void) | null = null;

  constructor(store?: SessionStore, ollama?: OllamaClient) {
    this.store = store ?? null;
    this.ollama = ollama ?? null;
  }

  setPrefsStore(prefsStore: UserPreferencesStore) {
    this.prefsStore = prefsStore;
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        cliSocket: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId),
        pendingPermissions: new Map(),
        messageHistory: [],
        pendingMessages: [],
        firstMessageReceived: false,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /**
   * Restore a session from persisted data (used during startup recovery).
   * Creates a session with pre-populated state and history but no sockets.
   */
  restoreSession(sessionId: string, state: SessionState, history: BrowserIncomingMessage[], archived?: boolean) {
    // Mark the state as archived so the browser knows
    if (archived) {
      state.archived = true;
    }
    const session: Session = {
      id: sessionId,
      cliSocket: null,
      browserSockets: new Set(),
      state,
      pendingPermissions: new Map(),
      messageHistory: history,
      pendingMessages: [],
      firstMessageReceived: history.some((msg) => msg.type === "user_message"),
      archived,
    };
    this.sessions.set(sessionId, session);
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Close CLI socket
    if (session.cliSocket) {
      try { session.cliSocket.close(); } catch {}
      session.cliSocket = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
  }

  /**
   * Update last activity timestamp (called on user messages and assistant responses).
   */
  private updateActivity(sessionId: string) {
    const now = Date.now();
    this.store?.load(sessionId).then((persisted) => {
      if (persisted) {
        this.store?.saveMeta(sessionId, { ...persisted.meta, lastActivityAt: now });
      }
    }).catch(() => {
      // Ignore errors
    });
    if (this.onActivity) {
      this.onActivity(sessionId);
    }
  }

  // ── External handlers (for OpenCode bridge etc.) ────────────────────────

  registerExternalHandler(sessionId: string, handler: (msg: Record<string, unknown>) => void) {
    this.externalHandlers.set(sessionId, handler);
  }

  unregisterExternalHandler(sessionId: string) {
    this.externalHandlers.delete(sessionId);
  }

  /** Inject a message to all browsers connected to a session (used by external bridges) */
  injectToBrowsers(sessionId: string, msg: BrowserIncomingMessage) {
    const session = this.getOrCreateSession(sessionId);
    session.messageHistory.push(msg);
    this.broadcastToBrowsers(session, msg);
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    console.log(`[ws-bridge] CLI connected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });

    // Flush any messages that were queued while waiting for CLI to connect
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) for session ${sessionId}`);
      for (const ndjson of session.pendingMessages) {
        this.sendToCLI(session, ndjson);
      }
      session.pendingMessages = [];
    }
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // NDJSON: split on newlines, parse each line
    const lines = data.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn(`[ws-bridge] Failed to parse CLI message: ${line.substring(0, 200)}`);
        continue;
      }
      this.routeCLIMessage(session, msg);
    }
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.cliSocket = null;
    console.log(`[ws-bridge] CLI disconnected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_disconnected" });

    // Cancel any pending permission requests
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.browserSockets.add(ws);
    console.log(`[ws-bridge] Browser connected for session ${sessionId} (${session.browserSockets.size} browsers)`);

    // Send current session state as snapshot
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: session.state,
    };
    this.sendToBrowser(ws, snapshot);

    // Replay message history so the browser can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Send any pending permission requests
    for (const perm of session.pendingPermissions.values()) {
      this.sendToBrowser(ws, { type: "permission_request", request: perm });
    }

    // Notify if CLI is not connected (but not for external-handler sessions like OpenCode)
    if (!session.cliSocket && !this.externalHandlers.has(sessionId)) {
      this.sendToBrowser(ws, { type: "cli_disconnected" });
    }
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let msg: BrowserOutgoingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
      return;
    }

    this.routeBrowserMessage(session, msg);
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    console.log(`[ws-bridge] Browser disconnected for session ${sessionId} (${session.browserSockets.size} browsers)`);
  }

  // ── CLI message routing ─────────────────────────────────────────────────

  private routeCLIMessage(session: Session, msg: CLIMessage) {
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(session, msg);
        break;

      case "assistant":
        this.handleAssistantMessage(session, msg as CLIAssistantMessage);
        break;

      case "result":
        this.handleResultMessage(session, msg as CLIResultMessage);
        break;

      case "stream_event":
        this.handleStreamEvent(session, msg as CLIStreamEventMessage);
        break;

      case "control_request":
        this.handleControlRequest(session, msg as CLIControlRequestMessage);
        break;

      case "tool_progress":
        this.handleToolProgress(session, msg as CLIToolProgressMessage);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(session, msg as CLIToolUseSummaryMessage);
        break;

      case "auth_status":
        this.handleAuthStatus(session, msg as CLIAuthStatusMessage);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(session: Session, msg: CLIMessage) {
    if (msg.type !== "system") return;

    const subtype = (msg as { subtype?: string }).subtype;

    if (subtype === "init") {
      const init = msg as unknown as CLISystemInitMessage;
      // Keep the launcher-assigned session_id as the canonical ID.
      // The CLI may report its own internal session_id which differs
      // from the launcher UUID, causing duplicate entries in the sidebar.
      session.state.model = init.model;
      session.state.cwd = init.cwd;
      session.state.tools = init.tools;
      session.state.permissionMode = init.permissionMode;
      session.state.claude_code_version = init.claude_code_version;
      session.state.mcp_servers = init.mcp_servers;
      session.state.agents = init.agents ?? [];
      session.state.slash_commands = init.slash_commands ?? [];
      session.state.skills = init.skills ?? [];
      if (init.context_used_percent !== undefined) {
        session.state.context_used_percent = init.context_used_percent;
      }
      if (init.is_compacting !== undefined) {
        session.state.is_compacting = init.is_compacting;
      }

      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: session.state,
      });
      this.store?.saveState(session.id, session.state);
    } else if (subtype === "status") {
      const status = (msg as { status?: "compacting" | null }).status;
      session.state.is_compacting = status === "compacting";

      const permMode = (msg as { permissionMode?: string }).permissionMode;
      if (permMode) {
        session.state.permissionMode = permMode;
      }

      this.broadcastToBrowsers(session, {
        type: "status_change",
        status: status ?? null,
      });
    }
    // Other system subtypes (compact_boundary, task_notification, etc.) can be forwarded as needed
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage) {
    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.store?.saveHistory(session.id, session.messageHistory);
    this.updateActivity(session.id);
  }

  private handleResultMessage(session: Session, msg: CLIResultMessage) {
    // Update session cost/turns
    session.state.total_cost_usd = msg.total_cost_usd;
    session.state.num_turns = msg.num_turns;

    // Check for direct context_used_percent first, then compute from modelUsage
    if (msg.context_used_percent !== undefined) {
      session.state.context_used_percent = msg.context_used_percent;
    } else if (msg.modelUsage) {
      for (const usage of Object.values(msg.modelUsage)) {
        if (usage.contextWindow > 0) {
          session.state.context_used_percent = Math.round(
            ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
          );
        }
      }
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.store?.saveState(session.id, session.state);
    this.store?.saveHistory(session.id, session.messageHistory);

    // Fire webhook if configured
    this.fireWebhook(session);
  }

  private fireWebhook(session: Session) {
    if (!this.prefsStore) return;
    this.prefsStore.load().then(async (prefs) => {
      if (!prefs.notificationsEnabled) return;
      const url = prefs.webhookUrl?.trim();
      if (!url) return;
      const sessionId = session.id;
      // Try to get the human-readable session name from the store
      let sessionName = sessionId;
      if (this.store) {
        const persisted = await this.store.load(sessionId).catch(() => null);
        if (persisted?.meta.sessionName) sessionName = persisted.meta.sessionName;
      }
      const appUrl = prefs.appUrl?.trim();
      const sessionUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/?session=${sessionId}` : undefined;
      const message = sessionUrl
        ? `FossClaw: '${sessionName}' is waiting for your input\n${sessionUrl}`
        : `FossClaw: '${sessionName}' is waiting for your input`;
      const payload: Record<string, unknown> = {
        text: message,
        content: message,
        event: "waiting_for_input",
        sessionId,
        sessionName,
        timestamp: new Date().toISOString(),
      };
      if (sessionUrl) payload.sessionUrl = sessionUrl;
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((err) => {
        console.error(`[ws-bridge] Webhook POST failed:`, err);
      });
    }).catch(() => {});
  }

  private handleStreamEvent(session: Session, msg: CLIStreamEventMessage) {
    this.broadcastToBrowsers(session, {
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage) {
    if (msg.request.subtype === "can_use_tool") {
      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions as PermissionRequest["permission_suggestions"],
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToBrowsers(session, {
        type: "permission_request",
        request: perm,
      });
    }
  }

  private handleToolProgress(session: Session, msg: CLIToolProgressMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(session: Session, msg: CLIToolUseSummaryMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  private handleAuthStatus(session: Session, msg: CLIAuthStatusMessage) {
    this.broadcastToBrowsers(session, {
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // ── Browser message routing ─────────────────────────────────────────────

  private routeBrowserMessage(session: Session, msg: BrowserOutgoingMessage) {
    // If an external handler is registered (e.g., OpenCode bridge), delegate to it
    const externalHandler = this.externalHandlers.get(session.id);
    if (externalHandler) {
      // Store user message in history for replay
      if (msg.type === "user_message") {
        session.messageHistory.push({
          type: "user_message",
          content: (msg as { content: string }).content,
          timestamp: Date.now(),
        });
        this.store?.saveHistory(session.id, session.messageHistory);
      }
      externalHandler(msg as unknown as Record<string, unknown>);
      return;
    }

    switch (msg.type) {
      case "user_message":
        // handleUserMessage is now async but we don't await it to avoid blocking
        this.handleUserMessage(session, msg);
        break;

      case "permission_response":
        this.handlePermissionResponse(session, msg);
        break;

      case "interrupt":
        this.handleInterrupt(session);
        break;

      case "set_model":
        this.handleSetModel(session, msg.model);
        break;

      case "set_permission_mode":
        this.handleSetPermissionMode(session, msg.mode);
        break;
    }
  }

  private async handleUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] }
  ) {
    // Block user messages for archived sessions
    if (session.archived) {
      console.warn(`[ws-bridge] Ignoring user message for archived session ${session.id}`);
      this.broadcastToBrowsers(session, {
        type: "error" as any,
        message: "This session is archived and read-only. The CLI process has exited.",
      });
      return;
    }

    const now = Date.now();

    // Store user message in history for replay (text-only for replay)
    session.messageHistory.push({
      type: "user_message",
      content: msg.content,
      timestamp: now,
    });
    this.store?.saveHistory(session.id, session.messageHistory);

    // Update last activity timestamp
    this.updateActivity(session.id);

    // Auto-name session on first user message
    if (!session.firstMessageReceived && this.ollama && this.store) {
      session.firstMessageReceived = true;

      // Generate name asynchronously (don't block the message)
      this.ollama.generateSessionName(msg.content).then((name) => {
        if (name) {
          console.log(`[ws-bridge] Auto-naming session ${session.id}: "${name}"`);
          // Load current meta and update with the generated name
          this.store?.load(session.id).then((persisted) => {
            if (persisted) {
              this.store?.saveMeta(session.id, { ...persisted.meta, sessionName: name });
            }
          }).catch((err) => {
            console.error(`[ws-bridge] Failed to update session name:`, err);
          });
        }
      }).catch((err) => {
        console.error(`[ws-bridge] Failed to generate session name:`, err);
      });
    }

    // Build content: if images are present, use content block array; otherwise plain string
    let content: string | unknown[];
    if (msg.images?.length) {
      const blocks: unknown[] = [];
      for (const img of msg.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.media_type, data: img.data },
        });
      }
      blocks.push({ type: "text", text: msg.content });
      content = blocks;
    } else {
      content = msg.content;
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || session.state.session_id || "",
    });
    this.sendToCLI(session, ndjson);
  }

  private handlePermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string }
  ) {
    // Remove from pending
    const pending = session.pendingPermissions.get(msg.request_id);
    session.pendingPermissions.delete(msg.request_id);

    if (msg.behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? pending?.input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      });
      this.sendToCLI(session, ndjson);
    } else {
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      });
      this.sendToCLI(session, ndjson);
    }
  }

  private handleInterrupt(session: Session) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetModel(session: Session, model: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetPermissionMode(session: Session, mode: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToCLI(session, ndjson);
  }

  // ── Transport helpers ───────────────────────────────────────────────────

  private sendToCLI(session: Session, ndjson: string) {
    if (!session.cliSocket) {
      // Queue the message — CLI might still be starting up
      console.log(`[ws-bridge] CLI not yet connected for session ${session.id}, queuing message`);
      session.pendingMessages.push(ndjson);
      return;
    }
    try {
      // NDJSON requires a newline delimiter
      session.cliSocket.send(ndjson + "\n");
    } catch (err) {
      console.error(`[ws-bridge] Failed to send to CLI for session ${session.id}:`, err);
    }
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    const json = JSON.stringify(msg);
    for (const ws of session.browserSockets) {
      try {
        ws.send(json);
      } catch {
        session.browserSockets.delete(ws);
      }
    }
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket will be cleaned up on close
    }
  }
}
