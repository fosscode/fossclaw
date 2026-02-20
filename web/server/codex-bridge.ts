import type { Subprocess } from "bun";
import type { WsBridge } from "./ws-bridge.js";
import type { ContentBlock } from "./session-types.js";

/**
 * Bridge between FossClaw and a Codex (OpenAI Codex CLI) server.
 * Manages the codex serve process, SSE event subscription,
 * and translates between FossClaw's WebSocket protocol and Codex's HTTP/SSE API.
 *
 * Codex CLI server API (codex serve --port <port>):
 *   GET  /health                          — health check
 *   POST /session                         — create session
 *   POST /session/:id/message             — send message (async)
 *   POST /session/:id/interrupt           — interrupt running session
 *   GET  /events                          — SSE event stream
 *   GET  /models                          — list available models
 */

export interface CodexModel {
  id: string;
  name: string;
}

interface CodexSessionMapping {
  /** Our FossClaw session UUID */
  fossclawId: string;
  /** Codex's internal session ID */
  codexId: string;
  cwd: string;
  model?: string;
}

export class CodexBridge {
  private port: number;
  private proc: Subprocess | null = null;
  private baseUrl: string;
  private sessions = new Map<string, CodexSessionMapping>();
  private sseAbort: AbortController | null = null;
  private wsBridge: WsBridge | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;

  constructor(port: number) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  setWsBridge(bridge: WsBridge) {
    this.wsBridge = bridge;
  }

  /** Start the codex serve process and wait for it to be healthy */
  async start(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this._start();
    return this.readyPromise;
  }

  private async _start(): Promise<void> {
    // Check if a Codex server is already running on this port
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (res.ok) {
        this.ready = true;
        console.log(`[codex] Server already running on port ${this.port}`);
        this.subscribeSSE();
        return;
      }
    } catch {
      // Not running — we'll spawn it
    }

    console.log(`[codex] Starting codex serve on port ${this.port}...`);

    try {
      this.proc = Bun.spawn(["codex", "serve", "--port", String(this.port)], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env as Record<string, string> },
      });
    } catch (err) {
      throw new Error(`Failed to spawn codex: ${err instanceof Error ? err.message : String(err)}. Is codex installed?`);
    }

    // Pipe output for debugging
    this.pipeOutput();

    // Wait for server to be healthy
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));

      // Check if process exited prematurely (likely port conflict)
      if (this.proc.exitCode !== null) {
        console.warn(`[codex] Spawned process exited with code ${this.proc.exitCode}, checking for existing server...`);
        try {
          const res = await fetch(`${this.baseUrl}/health`);
          if (res.ok) {
            this.ready = true;
            console.log(`[codex] Using existing server on port ${this.port}`);
            this.subscribeSSE();
            return;
          }
        } catch {
          // No existing server either
        }
        throw new Error(`Codex process exited prematurely with code ${this.proc.exitCode} and no existing server found`);
      }

      try {
        const res = await fetch(`${this.baseUrl}/health`);
        if (res.ok) {
          this.ready = true;
          console.log(`[codex] Server healthy on port ${this.port}`);
          this.subscribeSSE();
          return;
        }
      } catch {
        // still starting
      }
    }
    throw new Error("Codex server failed to start within 30s");
  }

  /** Ensure server is running (lazy start) */
  private async ensureRunning(): Promise<void> {
    if (!this.ready) await this.start();
  }

  /** Create a Codex session, returns our internal mapping */
  async createSession(fossclawId: string, cwd: string, model?: string): Promise<CodexSessionMapping> {
    await this.ensureRunning();

    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `FossClaw ${fossclawId.slice(0, 8)}`,
        cwd,
        ...(model ? { model } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Failed to create Codex session: ${res.statusText}`);
    const data = await res.json() as { id: string };

    const mapping: CodexSessionMapping = {
      fossclawId,
      codexId: data.id,
      cwd,
      model,
    };
    this.sessions.set(fossclawId, mapping);

    // Register as external handler in WsBridge
    if (this.wsBridge) {
      this.wsBridge.registerExternalHandler(fossclawId, (msg) => this.handleBrowserMessage(fossclawId, msg as { type: string; [key: string]: unknown }));

      // Inject a synthetic session_init so the browser marks this session as connected
      this.wsBridge.injectToBrowsers(fossclawId, {
        type: "session_init",
        session: {
          session_id: fossclawId,
          model: model || "unknown",
          cwd: cwd || "",
          tools: [],
          permissionMode: "ask",
          claude_code_version: "",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
        },
      } as import("./session-types.js").BrowserIncomingMessage);
    }

    return mapping;
  }

  /** Send a message to a Codex session (async — results come via SSE) */
  async sendMessage(fossclawId: string, text: string, images?: { media_type: string; data: string }[]) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping) throw new Error(`No Codex session for ${fossclawId}`);

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

    // Notify browser that generation is starting
    if (this.wsBridge) {
      this.wsBridge.injectToBrowsers(fossclawId, {
        type: "stream_event",
        event: { type: "message_start" },
        parent_tool_use_id: null,
      });
    }

    const res = await fetch(`${this.baseUrl}/session/${mapping.codexId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Codex message failed: ${err}`);
    }
  }

  /** Interrupt a running Codex session */
  async abort(fossclawId: string) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping) return;
    try {
      await fetch(`${this.baseUrl}/session/${mapping.codexId}/interrupt`, { method: "POST" });
    } catch { /* best effort */ }
  }

  /** List available models from Codex */
  async listModels(): Promise<CodexModel[]> {
    await this.ensureRunning();

    try {
      const res = await fetch(`${this.baseUrl}/models`);
      if (!res.ok) return [];

      const data = await res.json() as {
        models?: Array<{ id: string; name?: string }>;
      } | Array<{ id: string; name?: string }>;

      const rawModels = Array.isArray(data) ? data : (data.models || []);
      return rawModels.map((m) => ({
        id: m.id,
        name: m.name || m.id,
      }));
    } catch {
      return [];
    }
  }

  /** Check if a session is a Codex session */
  isCodexSession(fossclawId: string): boolean {
    return this.sessions.has(fossclawId);
  }

  /** Remove session mapping */
  removeSession(fossclawId: string) {
    this.sessions.delete(fossclawId);
    if (this.wsBridge) {
      this.wsBridge.unregisterExternalHandler(fossclawId);
    }
  }

  /** Handle messages coming from the browser for Codex sessions */
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
          console.error(`[codex] Failed to send message:`, e);
        }
        break;
      }
      case "interrupt":
        await this.abort(fossclawId);
        break;
    }
  }

  /** Subscribe to Codex SSE events and route them to browser WebSockets */
  private async subscribeSSE() {
    if (this.sseAbort) this.sseAbort.abort();
    this.sseAbort = new AbortController();

    const connect = async () => {
      try {
        console.log("[codex] Connecting to SSE event stream...");
        const res = await fetch(`${this.baseUrl}/events`, {
          signal: this.sseAbort!.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok) {
          console.error(`[codex] SSE connection failed: ${res.status} ${res.statusText}`);
          if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
            console.log("[codex] Retrying SSE connection in 5s...");
            setTimeout(() => connect(), 5000);
          }
          return;
        }

        if (!res.body) {
          console.error("[codex] SSE response has no body");
          if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
            setTimeout(() => connect(), 5000);
          }
          return;
        }

        console.log("[codex] SSE connection established");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[codex] SSE stream ended (received ${eventCount} events)`);
            if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
              console.log("[codex] Reconnecting SSE in 2s...");
              setTimeout(() => connect(), 2000);
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              try {
                const data = JSON.parse(line.slice(5).trim());
                const eventType = data.type as string;
                if (eventType) {
                  eventCount++;
                  console.log(`[codex] SSE event: ${eventType}`);
                  this.handleSSEEvent(eventType, data);
                }
              } catch (err) {
                console.error("[codex] Failed to parse SSE event:", err);
              }
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") {
          console.log("[codex] SSE connection aborted");
          return;
        }
        console.error("[codex] SSE connection error:", e);
        if (this.ready && this.sseAbort && !this.sseAbort.signal.aborted) {
          console.log("[codex] Reconnecting in 5s...");
          setTimeout(() => connect(), 5000);
        }
      }
    };

    connect();
  }

  /** Find the fossclaw session ID that corresponds to a Codex session ID */
  private findFossclawSession(codexSessionId: string): string | undefined {
    for (const [wId, mapping] of this.sessions) {
      if (mapping.codexId === codexSessionId) return wId;
    }
    return undefined;
  }

  /** Route an SSE event to the appropriate browser session */
  private handleSSEEvent(eventType: string, data: Record<string, unknown>) {
    const props = (data.properties || data) as Record<string, unknown>;

    const codexSessionId = (props.sessionId || props.session_id) as string | undefined;
    const sessionId = codexSessionId ? this.findFossclawSession(codexSessionId) : undefined;

    if (!sessionId || !this.wsBridge) return;

    switch (eventType) {
      case "message.delta":
      case "text.delta": {
        const delta = (props.delta || props.text) as string | undefined;
        if (delta) {
          this.wsBridge.injectToBrowsers(sessionId, {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: delta },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "message.complete":
      case "turn.complete": {
        const content = (props.content || props.text) as string | undefined;
        const toolCalls = props.tool_calls as Array<{ id: string; name: string; input: Record<string, unknown>; output?: string }> | undefined;

        const contentBlocks: ContentBlock[] = [];

        if (content) {
          contentBlocks.push({ type: "text", text: content });
        }

        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
            if (tc.output !== undefined) {
              contentBlocks.push({ type: "tool_result", tool_use_id: tc.id, content: tc.output });
            }
          }
        }

        if (contentBlocks.length > 0) {
          const hasToolUse = contentBlocks.some(b => b.type === "tool_use");
          this.wsBridge.injectToBrowsers(sessionId, {
            type: "assistant",
            message: {
              type: "message",
              id: (props.id as string) || crypto.randomUUID(),
              role: "assistant",
              content: contentBlocks,
              model: (props.model as string) || "",
              stop_reason: hasToolUse ? "tool_use" : "stop",
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
            parent_tool_use_id: null,
          });
        }

        // Signal completion
        this.wsBridge.injectToBrowsers(sessionId, {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            num_turns: 1,
            is_error: false,
            session_id: sessionId,
            uuid: crypto.randomUUID(),
            duration_ms: 0,
            duration_api_ms: 0,
            stop_reason: "stop",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        });
        break;
      }

      case "tool.start": {
        const toolName = (props.tool || props.name) as string | undefined;
        const callId = (props.callId || props.id) as string | undefined;
        if (toolName && callId) {
          this.wsBridge.injectToBrowsers(sessionId, {
            type: "tool_progress",
            tool_use_id: callId,
            tool_name: toolName,
            elapsed_time_seconds: 0,
          });
        }
        break;
      }

      case "error": {
        const errMsg = (props.message || props.error) as string | undefined;
        if (errMsg) {
          this.wsBridge.injectToBrowsers(sessionId, {
            type: "assistant",
            message: {
              type: "message",
              id: crypto.randomUUID(),
              role: "assistant",
              content: [{ type: "text", text: `**Error:** ${errMsg}` }],
              model: "",
              stop_reason: "stop",
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "session.idle":
      case "idle": {
        this.wsBridge.injectToBrowsers(sessionId, {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            num_turns: 1,
            is_error: false,
            session_id: sessionId,
            uuid: crypto.randomUUID(),
            duration_ms: 0,
            duration_api_ms: 0,
            stop_reason: "stop",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        });
        break;
      }
    }
  }

  /** Stop the codex server */
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
          if (text) console.log(`[codex:${label}] ${text}`);
        }
      } catch { /* stream closed */ }
    };
    if (proc.stdout && typeof proc.stdout !== "number") pipe(proc.stdout, "stdout");
    if (proc.stderr && typeof proc.stderr !== "number") pipe(proc.stderr, "stderr");
  }
}
