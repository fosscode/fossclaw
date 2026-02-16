import type { Subprocess } from "bun";
import type { WsBridge } from "./ws-bridge.js";

/**
 * Bridge between FossClaw and an OpenCode server.
 * Manages the opencode serve process, SSE event subscription,
 * and translates between FossClaw's WebSocket protocol and OpenCode's HTTP/SSE API.
 */

export interface OpenCodeModel {
  id: string;
  name: string;
  providerID: string;
}

interface OpenCodeSessionMapping {
  /** Our FossClaw session UUID */
  fossclawId: string;
  /** OpenCode's session ID (ses_...) */
  opencodeId: string;
  cwd: string;
  model?: string;
  providerID?: string;
}

export class OpenCodeBridge {
  private port: number;
  private proc: Subprocess | null = null;
  private baseUrl: string;
  private sessions = new Map<string, OpenCodeSessionMapping>();
  private sseAbort: AbortController | null = null;
  private wsBridge: WsBridge | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  /** Track message roles: OpenCode messageID → role (user/assistant) */
  private messageRoles = new Map<string, string>();

  constructor(port: number) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  setWsBridge(bridge: WsBridge) {
    this.wsBridge = bridge;
  }

  /** Start the opencode serve process and wait for it to be healthy */
  async start(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this._start();
    return this.readyPromise;
  }

  private async _start(): Promise<void> {
    // Check if an OpenCode server is already running on this port
    try {
      const res = await fetch(`${this.baseUrl}/global/health`);
      if (res.ok) {
        this.ready = true;
        console.log(`[opencode] Server already running on port ${this.port}`);
        this.subscribeSSE();
        return;
      }
    } catch {
      // Not running — we'll spawn it
    }

    console.log(`[opencode] Starting opencode serve on port ${this.port}...`);

    try {
      this.proc = Bun.spawn(["opencode", "serve", "--port", String(this.port)], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env as Record<string, string> },
      });
    } catch (err) {
      throw new Error(`Failed to spawn opencode: ${err instanceof Error ? err.message : String(err)}. Is opencode installed?`);
    }

    // Pipe output for debugging
    this.pipeOutput();

    // Wait for server to be healthy
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));

      // Check if process exited prematurely (likely port conflict)
      if (this.proc.exitCode !== null) {
        console.warn(`[opencode] Spawned process exited with code ${this.proc.exitCode}, checking for existing server...`);
        // Maybe another server is already running - check again
        try {
          const res = await fetch(`${this.baseUrl}/global/health`);
          if (res.ok) {
            this.ready = true;
            console.log(`[opencode] Using existing server on port ${this.port}`);
            this.subscribeSSE();
            return;
          }
        } catch {
          // No existing server either
        }
        throw new Error(`OpenCode process exited prematurely with code ${this.proc.exitCode} and no existing server found`);
      }

      try {
        const res = await fetch(`${this.baseUrl}/global/health`);
        if (res.ok) {
          this.ready = true;
          console.log(`[opencode] Server healthy on port ${this.port}`);
          this.subscribeSSE();
          return;
        }
      } catch {
        // still starting
      }
    }
    throw new Error("OpenCode server failed to start within 30s");
  }

  /** Ensure server is running (lazy start) */
  private async ensureRunning(): Promise<void> {
    if (!this.ready) await this.start();
  }

  /** Create an OpenCode session, returns our internal mapping */
  async createSession(fossclawId: string, cwd: string, model?: string, providerID?: string): Promise<OpenCodeSessionMapping> {
    await this.ensureRunning();

    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `FossClaw ${fossclawId.slice(0, 8)}` }),
    });
    if (!res.ok) throw new Error(`Failed to create OpenCode session: ${res.statusText}`);
    const data = await res.json() as { id: string };

    const mapping: OpenCodeSessionMapping = {
      fossclawId,
      opencodeId: data.id,
      cwd,
      model,
      providerID,
    };
    this.sessions.set(fossclawId, mapping);

    // Register as external handler in WsBridge
    if (this.wsBridge) {
      this.wsBridge.registerExternalHandler(fossclawId, (msg) => this.handleBrowserMessage(fossclawId, msg));

      // Inject a synthetic session_init so the browser marks this session as connected
      this.wsBridge.injectToBrowsers(fossclawId, {
        type: "session_init",
        session: {
          session_id: fossclawId,
          model: model || "unknown",
          provider: "opencode",
        },
      });
    }

    return mapping;
  }

  /** Send a message to an OpenCode session (async — results come via SSE) */
  async sendMessage(fossclawId: string, text: string, images?: { media_type: string; data: string }[]) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping) throw new Error(`No OpenCode session for ${fossclawId}`);

    const parts: unknown[] = [];
    if (images?.length) {
      for (const img of images) {
        parts.push({
          type: "image",
          url: `data:${img.media_type};base64,${img.data}`,
        });
      }
    }
    parts.push({ type: "text", text });

    const body: Record<string, unknown> = { parts };
    if (mapping.providerID && mapping.model) {
      body.model = { providerID: mapping.providerID, modelID: mapping.model };
    }

    // Notify browser that generation is starting
    if (this.wsBridge) {
      this.wsBridge.injectToBrowsers(fossclawId, {
        type: "stream_event",
        event: { type: "message_start" },
      });
    }

    // Use prompt_async so we don't block — SSE events will stream the response
    const res = await fetch(`${this.baseUrl}/session/${mapping.opencodeId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenCode message failed: ${err}`);
    }
  }

  /** Abort a running OpenCode session */
  async abort(fossclawId: string) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping) return;
    try {
      await fetch(`${this.baseUrl}/session/${mapping.opencodeId}/abort`, { method: "POST" });
    } catch { /* best effort */ }
  }

  /** List available models from OpenCode */
  async listModels(): Promise<OpenCodeModel[]> {
    await this.ensureRunning();

    const res = await fetch(`${this.baseUrl}/config/providers`);
    if (!res.ok) return [];

    const data = await res.json() as {
      providers: Array<{
        id: string;
        name: string;
        models: Record<string, { id: string; name?: string; status?: string }>;
      }>;
    };

    const models: OpenCodeModel[] = [];
    for (const provider of data.providers) {
      for (const [, model] of Object.entries(provider.models || {})) {
        if (model.status === "active" || !model.status) {
          models.push({
            id: model.id,
            name: model.name || model.id,
            providerID: provider.id,
          });
        }
      }
    }
    return models;
  }

  /** Check if a session is an OpenCode session */
  isOpenCodeSession(fossclawId: string): boolean {
    return this.sessions.has(fossclawId);
  }

  /** Remove session mapping */
  removeSession(fossclawId: string) {
    this.sessions.delete(fossclawId);
    if (this.wsBridge) {
      this.wsBridge.unregisterExternalHandler(fossclawId);
    }
  }

  /** Get context information for an OpenCode session */
  async getContext(fossclawId: string): Promise<{
    tokens?: { used: number; max: number };
    error?: string;
  }> {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping) {
      return { error: "Session not found" };
    }

    try {
      const res = await fetch(`${this.baseUrl}/session/${mapping.opencodeId}/context`);
      if (!res.ok) {
        return { error: `Failed to fetch context: ${res.statusText}` };
      }

      const data = await res.json() as {
        tokens?: { used: number; max: number };
        [key: string]: unknown;
      };

      return {
        tokens: data.tokens,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg };
    }
  }

  /** Handle messages coming from the browser for OpenCode sessions */
  private async handleBrowserMessage(fossclawId: string, msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case "user_message": {
        const content = msg.content as string;
        const images = msg.images as { media_type: string; data: string }[] | undefined;

        // Notify browser that we're "running"
        if (this.wsBridge) {
          this.wsBridge.injectToBrowsers(fossclawId, { type: "status_change", status: null });
        }

        try {
          await this.sendMessage(fossclawId, content, images);
        } catch (e) {
          console.error(`[opencode] Failed to send message:`, e);
        }
        break;
      }
      case "interrupt":
        await this.abort(fossclawId);
        break;
    }
  }

  /** Subscribe to OpenCode SSE events and route them to browser WebSockets */
  private async subscribeSSE() {
    if (this.sseAbort) this.sseAbort.abort();
    this.sseAbort = new AbortController();

    const connect = async () => {
      try {
        console.log("[opencode] Connecting to SSE event stream...");
        const res = await fetch(`${this.baseUrl}/event`, {
          signal: this.sseAbort!.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok) {
          console.error(`[opencode] SSE connection failed: ${res.status} ${res.statusText}`);
          // Retry connection after delay
          if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
            console.log("[opencode] Retrying SSE connection in 5s...");
            setTimeout(() => connect(), 5000);
          }
          return;
        }

        if (!res.body) {
          console.error("[opencode] SSE response has no body");
          // Retry connection after delay
          if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
            console.log("[opencode] Retrying SSE connection in 5s...");
            setTimeout(() => connect(), 5000);
          }
          return;
        }

        console.log("[opencode] SSE connection established");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[opencode] SSE stream ended (received ${eventCount} events)`);
            // Reconnect if we're still supposed to be active
            if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
              console.log("[opencode] Reconnecting SSE in 2s...");
              setTimeout(() => connect(), 2000);
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines — OpenCode sends: data: {"type":"event.type","properties":{...}}
          // No separate `event:` lines; the event type is inside the JSON `type` field
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                const eventType = data.type as string;
                if (eventType) {
                  eventCount++;
                  // Log event types for debugging (except common/noisy ones)
                  if (!eventType.includes("session.diff") && !eventType.includes("server.connected")) {
                    console.log(`[opencode] SSE event: ${eventType}`);
                  }
                  this.handleSSEEvent(eventType, data);
                }
              } catch (err) {
                console.error("[opencode] Failed to parse SSE event:", err);
                console.error("[opencode] Problematic line:", line);
              }
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") {
          console.log("[opencode] SSE connection aborted");
          return;
        }
        console.error("[opencode] SSE connection error:", e);
        if (e instanceof Error) {
          console.error("[opencode] Error details:", { name: e.name, message: e.message, stack: e.stack });
        }
        // Only reconnect if we're still supposed to be ready
        if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
          console.log("[opencode] Reconnecting in 5s...");
          setTimeout(() => connect(), 5000);
        }
      }
    };

    connect();
  }

  /** Find the fossclaw session ID that corresponds to an OpenCode session ID */
  private findFossclawSession(opencodeSessionId: string): string | undefined {
    for (const [wId, mapping] of this.sessions) {
      if (mapping.opencodeId === opencodeSessionId) return wId;
    }
    return undefined;
  }

  /** Extract the OpenCode sessionID from an SSE event payload */
  private extractOpenCodeSessionId(props: Record<string, unknown>): string | undefined {
    // Direct sessionID on properties
    if (props.sessionID) return props.sessionID as string;
    // Nested in part object (message.part.updated)
    const part = props.part as Record<string, unknown> | undefined;
    if (part?.sessionID) return part.sessionID as string;
    // Nested in info object (message.updated)
    const info = props.info as Record<string, unknown> | undefined;
    if (info?.sessionID) return info.sessionID as string;
    return undefined;
  }

  /** Route an SSE event to the appropriate browser session */
  private handleSSEEvent(eventType: string, data: Record<string, unknown>) {
    const props = data.properties as Record<string, unknown> | undefined;
    if (!props) return;

    const ocSessionId = this.extractOpenCodeSessionId(props);
    const sessionId = ocSessionId ? this.findFossclawSession(ocSessionId) : undefined;

    if (!sessionId || !this.wsBridge) return;

    switch (eventType) {
      case "message.part.updated": {
        const part = props.part as Record<string, unknown>;
        const delta = props.delta as string | undefined;

        // Skip parts from user messages — only stream assistant content
        const msgId = part?.messageID as string | undefined;
        if (msgId && this.messageRoles.get(msgId) === "user") break;

        // Debug: log part structure to understand what OpenCode sends
        if (part?.type === "text") {
          console.log(`[opencode] text part: delta=${delta !== undefined}, delta_len=${delta?.length}, text_len=${(part.text as string)?.length}, keys=${Object.keys(props).join(",")}`);
        }

        if (part?.type === "text" && delta) {
          // Streaming text — send as stream_event (only when there's a delta, not full-text updates)
          this.wsBridge.injectToBrowsers(sessionId, {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: delta },
            },
          });
        } else if (part?.type === "tool") {
          // OpenCode tool call: part.tool = tool name, part.state = { status, input, output }
          const toolName = (part.tool as string) || "tool";
          const state = part.state as Record<string, unknown> | undefined;
          const status = state?.status as string;
          const callID = (part.callID as string) || (part.id as string) || "";

          if (status === "running" || status === "pending") {
            // Show tool progress while it's running
            this.wsBridge.injectToBrowsers(sessionId, {
              type: "tool_progress",
              tool_use_id: callID,
              tool_name: toolName,
              elapsed_time_seconds: 0,
            });
          }
          // Completed/error tool results are included in the final assistant message
          // via fetchAndBroadcastMessage when message.updated fires with time.completed
        }
        break;
      }

      case "message.updated": {
        const info = props.info as Record<string, unknown>;
        if (!info) break;
        const role = info.role as string;
        const msgId = info.id as string;

        // Track message roles for filtering parts
        if (msgId && role) {
          this.messageRoles.set(msgId, role);
        }

        if (role === "assistant") {
          const time = info.time as { completed?: number } | undefined;
          const hasError = !!(info.error as Record<string, unknown> | undefined);
          if (time?.completed || hasError) {
            // Message complete (or errored) — fetch the full message to get all parts
            this.fetchAndBroadcastMessage(sessionId, info);
          }
        }
        break;
      }

      case "session.status": {
        const status = props.status as string | undefined;
        if (status === "busy") {
          this.wsBridge.injectToBrowsers(sessionId, { type: "status_change", status: null });
        }
        break;
      }

      case "session.idle": {
        // Session is done — send result to mark completion
        this.wsBridge.injectToBrowsers(sessionId, {
          type: "result",
          data: {
            type: "result",
            result: "",
            total_cost_usd: 0,
            num_turns: 1,
            is_error: false,
            session_id: sessionId,
          },
        });
        break;
      }

      case "session.updated":
      case "session.diff":
        break;

      case "permission.asked": {
        // Auto-approve OpenCode permissions (file access, etc.)
        const permId = props.id as string;
        if (permId) {
          const permType = (props.permission as string) || "unknown";
          const patterns = props.patterns as string[] | undefined;
          console.log(`[opencode] Auto-approving permission: ${permType} ${patterns?.join(", ") || ""}`);
          fetch(`${this.baseUrl}/permission/${permId}/reply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply: "always" }),
          }).catch((e) => console.error(`[opencode] Failed to approve permission:`, e));
        }
        break;
      }
    }
  }

  /** Fetch a completed message and broadcast it as an assistant message */
  private async fetchAndBroadcastMessage(fossclawId: string, info: Record<string, unknown>) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping || !this.wsBridge) return;

    try {
      const msgId = info.id as string;
      const res = await fetch(`${this.baseUrl}/session/${mapping.opencodeId}/message/${msgId}`);
      if (!res.ok) return;

      const data = await res.json() as {
        info: Record<string, unknown>;
        parts: Array<{ type: string; text?: string; tool?: string; callID?: string; state?: Record<string, unknown>; [key: string]: unknown }>;
      };

      // Build content blocks from all parts
      const contentBlocks: Record<string, unknown>[] = [];
      let fullText = "";

      for (const part of data.parts) {
        if (part.type === "text" && part.text) {
          contentBlocks.push({ type: "text", text: part.text });
          fullText += part.text + "\n";
        } else if (part.type === "tool" && part.tool) {
          // Tool call → tool_use block
          const callId = part.callID || part.id as string || "";
          contentBlocks.push({
            type: "tool_use",
            id: callId,
            name: part.tool,
            input: part.state?.input || {},
          });
          // Tool result → tool_result block
          if (part.state?.status === "completed" || part.state?.output) {
            const output = (part.state.output as string) || "";
            contentBlocks.push({
              type: "tool_result",
              tool_use_id: callId,
              content: output.length > 2000 ? output.slice(0, 2000) + "\n...(truncated)" : output,
            });
          }
        }
      }

      fullText = fullText.trim();

      // Check for error responses (empty parts but error in info)
      const msgInfo = data.info as Record<string, unknown>;
      const msgError = msgInfo.error as { name?: string; data?: { message?: string } } | undefined;
      if (contentBlocks.length === 0 && msgError) {
        const errorText = msgError.data?.message || msgError.name || "Unknown error from OpenCode";
        console.error(`[opencode] Message error for ${fossclawId}: ${errorText}`);
        contentBlocks.push({ type: "text", text: `**Error:** ${errorText}` });
      }

      if (contentBlocks.length > 0) {
        // Determine stop reason based on content
        const hasToolUse = contentBlocks.some(b => b.type === "tool_use");

        this.wsBridge.injectToBrowsers(fossclawId, {
          type: "assistant",
          message: {
            id: msgId,
            role: "assistant",
            content: contentBlocks,
            model: (msgInfo.modelID as string) || (info.modelID as string) || "",
            stop_reason: hasToolUse ? "tool_use" : "stop",
          },
        });

      }
    } catch (e) {
      console.error(`[opencode] Failed to fetch message:`, e);
    }
  }

  /** Stop the opencode server */
  async stop() {
    if (this.sseAbort) this.sseAbort.abort();
    if (this.proc) {
      this.proc.kill("SIGTERM");
      await Promise.race([
        this.proc.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      this.proc = null;
    }
    this.ready = false;
    this.readyPromise = null;
  }

  private pipeOutput() {
    if (!this.proc) return;
    const proc = this.proc;
    const pipe = async (stream: ReadableStream<Uint8Array> | null, label: string) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value).trim();
          if (text) console.log(`[opencode:${label}] ${text}`);
        }
      } catch { /* stream closed */ }
    };
    if (proc.stdout && typeof proc.stdout !== "number") pipe(proc.stdout, "stdout");
    if (proc.stderr && typeof proc.stderr !== "number") pipe(proc.stderr, "stderr");
  }
}
