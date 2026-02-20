import type { Subprocess } from "bun";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { WsBridge } from "./ws-bridge.js";

/**
 * Bridge between FossClaw and the Codex CLI app-server.
 *
 * The Codex CLI (v0.100+) exposes an app-server via JSON-RPC 2.0 over WebSocket:
 *   codex app-server --listen ws://127.0.0.1:PORT
 *
 * NOTE: Bun's built-in `new WebSocket()` always requests the `permessage-deflate`
 * extension, which codex app-server does not support and rejects by closing the
 * connection. We implement a minimal RFC-6455 WebSocket client over raw TCP so we
 * can omit that extension header.
 *
 * Key JSON-RPC methods (client → server):
 *   initialize      — handshake (required first)
 *   thread/start    — create a conversation thread
 *   turn/start      — send a user message and begin a turn
 *   turn/interrupt  — interrupt a running turn
 *   model/list      — list available models
 *
 * Key notifications (server → client, no "id" field):
 *   thread/started              — thread created
 *   turn/started                — agent turn began (gives us turn.id)
 *   turn/completed              — agent turn finished
 *   item/agentMessage/delta     — streaming text delta
 *   error                       — error notification
 *
 * Server requests (server → client, have "id" field, need response):
 *   item/commandExecution/requestApproval  — auto-approve
 *   item/fileChange/requestApproval        — auto-approve
 *   item/tool/requestUserInput             — auto-respond empty
 */

export interface CodexModel {
  id: string;
  name: string;
}

interface CodexSessionMapping {
  fossclawId: string;
  threadId: string;
  cwd: string;
  model?: string;
  currentTurnId?: string;
}

type JsonRpcId = string | number;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Minimal WebSocket client (RFC 6455) ───────────────────────────────────────
// Avoids Bun's built-in `new WebSocket()` which sends `permessage-deflate`.

class RawWsClient {
  private socket: Socket | null = null;
  private rxBuf = Buffer.alloc(0);
  private host: string;
  private port: number;
  private closed = false;

  onmessage: ((data: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  onerror: ((err: Error) => void) | null = null;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.port, this.host);
      this.socket = sock;

      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error("TCP connection timeout"));
      }, 3000);

      sock.once("connect", () => {
        clearTimeout(timeout);
        // Send HTTP upgrade WITHOUT permessage-deflate
        const key = randomBytes(16).toString("base64");
        const req = [
          `GET / HTTP/1.1`,
          `Host: ${this.host}:${this.port}`,
          `Connection: Upgrade`,
          `Upgrade: websocket`,
          `Sec-WebSocket-Version: 13`,
          `Sec-WebSocket-Key: ${key}`,
          ``,
          ``,
        ].join("\r\n");
        sock.write(req);

        // Wait for the 101 response
        const readUpgrade = (chunk: Buffer) => {
          this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
          const headerEnd = this.rxBuf.indexOf("\r\n\r\n");
          if (headerEnd === -1) return; // not enough data yet

          sock.removeListener("data", readUpgrade);
          const header = this.rxBuf.slice(0, headerEnd + 4).toString();
          this.rxBuf = this.rxBuf.slice(headerEnd + 4);

          if (!header.includes("101 Switching Protocols")) {
            sock.destroy();
            reject(new Error(`Bad HTTP upgrade response: ${header.slice(0, 100)}`));
            return;
          }

          // Switch to WebSocket frame mode
          sock.on("data", (d: Buffer) => this.handleData(d));
          resolve();
        };

        sock.on("data", readUpgrade);
      });

      sock.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      sock.on("error", (err) => {
        if (!this.closed) this.onerror?.(err);
      });

      sock.on("close", () => {
        if (!this.closed) {
          this.closed = true;
          this.onclose?.(1006);
        }
      });
    });
  }

  send(data: string): void {
    if (!this.socket || this.closed) return;
    const payload = Buffer.from(data, "utf-8");
    const maskKey = randomBytes(4);
    const header = this.makeFrameHeader(payload.length);
    // Append mask bit
    header[1] |= 0x80;
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ maskKey[i % 4];
    }
    this.socket.write(Buffer.concat([header, maskKey, masked]));
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Send close frame
      if (this.socket && !this.socket.destroyed) {
        const closeFrame = Buffer.from([0x88, 0x82, 0x00, 0x00, 0x00, 0x00, code >> 8, code & 0xff]);
        this.socket.write(closeFrame);
        this.socket.end();
      }
    } catch { /* ignore */ }
  }

  terminate(): void {
    this.closed = true;
    this.socket?.destroy();
  }

  private makeFrameHeader(len: number): Buffer {
    // FIN=1, opcode=1 (text), MASK bit added by caller
    const b0 = 0x81;
    if (len <= 125) return Buffer.from([b0, len]);
    if (len <= 65535) return Buffer.from([b0, 126, len >> 8, len & 0xff]);
    // len > 65535 (very large messages — unlikely for JSON-RPC)
    const buf = Buffer.allocUnsafe(10);
    buf[0] = b0;
    buf[1] = 127;
    buf.writeBigUInt64BE(BigInt(len), 2);
    return buf;
  }

  private handleData(chunk: Buffer): void {
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);

    // Parse all complete frames from buffer
    while (this.rxBuf.length >= 2) {
      const b0 = this.rxBuf[0];
      const b1 = this.rxBuf[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.rxBuf.length < 4) break;
        payloadLen = this.rxBuf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.rxBuf.length < 10) break;
        payloadLen = Number(this.rxBuf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this.rxBuf.length < totalLen) break;

      const payload = this.rxBuf.slice(offset + maskLen, totalLen);
      if (masked) {
        const maskKey = this.rxBuf.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }

      this.rxBuf = this.rxBuf.slice(totalLen);

      switch (opcode) {
        case 1: // text frame
          this.onmessage?.(payload.toString("utf-8"));
          break;
        case 8: // close frame
          if (!this.closed) {
            this.closed = true;
            this.onclose?.(1000);
          }
          break;
        case 9: // ping — send pong
          this.sendPong(payload);
          break;
        // opcode 0 (continuation), 2 (binary), 10 (pong) — ignore
      }
    }
  }

  private sendPong(payload: Buffer): void {
    if (!this.socket || this.closed) return;
    const frame = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
    this.socket.write(frame);
  }
}

// ── CodexBridge ───────────────────────────────────────────────────────────────

export class CodexBridge {
  private port: number;
  private proc: Subprocess | null = null;
  private sessions = new Map<string, CodexSessionMapping>();
  private threadToFossclaw = new Map<string, string>();
  private wsBridge: WsBridge | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private ws: RawWsClient | null = null;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private requestCounter = 0;
  private stopping = false;

  constructor(port: number) {
    this.port = port;
  }

  setWsBridge(bridge: WsBridge) {
    this.wsBridge = bridge;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._start();
    return this.readyPromise;
  }

  private async _start(): Promise<void> {
    // Try connecting to an already-running server first
    try {
      await this.connectWs();
      this.ready = true;
      console.log(`[codex] Connected to existing app-server on port ${this.port}`);
      return;
    } catch {
      // Not running — spawn it
    }

    console.log(`[codex] Starting codex app-server on port ${this.port}...`);
    try {
      this.proc = Bun.spawn(
        ["codex", "app-server", "--listen", `ws://127.0.0.1:${this.port}`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...(process.env as Record<string, string>) },
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to spawn codex app-server: ${msg}. Is codex installed?`);
    }

    this.pipeOutput();

    // Wait up to 20s for the server to come up
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));

      if (this.proc.exitCode !== null) {
        throw new Error(`codex process exited prematurely with code ${this.proc.exitCode}`);
      }

      try {
        await this.connectWs();
        this.ready = true;
        console.log(`[codex] app-server ready on port ${this.port}`);
        return;
      } catch {
        // still starting
      }
    }

    throw new Error("Codex app-server failed to start within 20s");
  }

  private async connectWs(): Promise<void> {
    const ws = new RawWsClient("127.0.0.1", this.port);
    await ws.connect();

    this.ws = ws;
    this.setupWsHandlers();

    try {
      await this.request("initialize", {
        clientInfo: { name: "FossClaw", title: "FossClaw", version: "1.0.0" },
        capabilities: { experimentalApi: false },
      });
    } catch (err) {
      ws.terminate();
      this.ws = null;
      throw err;
    }
  }

  private setupWsHandlers() {
    const ws = this.ws;
    if (!ws) return;

    ws.onmessage = (data: string) => {
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;
        this.handleWsMessage(msg);
      } catch (err) {
        console.error("[codex] Failed to parse WS message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[codex] WebSocket disconnected");
      this.ws = null;

      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WebSocket disconnected"));
        this.pendingRequests.delete(id);
      }

      if (this.ready && !this.stopping) {
        this.ready = false;
        this.readyPromise = null;
        console.log("[codex] Reconnecting in 3s...");
        setTimeout(() => {
          if (!this.stopping) {
            this.start().catch((err) => console.error("[codex] Reconnect failed:", err));
          }
        }, 3000);
      }
    };

    ws.onerror = (err: Error) => {
      console.error("[codex] WebSocket error:", err.message);
    };
  }

  private handleWsMessage(msg: Record<string, unknown>) {
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;

    // JSON-RPC response (has 'id', 'result' or 'error', no 'method')
    if (hasId && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const id = msg.id as JsonRpcId;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        if ("error" in msg) {
          const err = msg.error as { message?: string; code?: number };
          pending.reject(new Error(err?.message || "JSON-RPC error"));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC server→client request (has both 'method' and 'id')
    if (hasId && "method" in msg) {
      this.handleServerRequest(
        msg.method as string,
        msg.id as JsonRpcId,
        (msg.params ?? {}) as Record<string, unknown>
      );
      return;
    }

    // JSON-RPC notification (has 'method', no 'id')
    if (!hasId && "method" in msg) {
      this.handleNotification(
        msg.method as string,
        (msg.params ?? {}) as Record<string, unknown>
      );
    }
  }

  /** Auto-respond to server-initiated approval requests */
  private handleServerRequest(method: string, id: JsonRpcId, _params: Record<string, unknown>) {
    let result: unknown;

    switch (method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "accept" };
        break;
      case "item/tool/requestUserInput":
        result = { response: "" };
        break;
      case "applyPatchApproval":
        result = { decision: "accept" };
        break;
      case "execCommandApproval":
        result = { decision: "acceptForSession" };
        break;
      default:
        result = {};
    }

    this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private handleNotification(method: string, params: Record<string, unknown>) {
    const threadId =
      (params.threadId as string | undefined) ||
      ((params.thread as Record<string, unknown> | undefined)?.id as string | undefined);

    const fossclawId = threadId ? this.threadToFossclaw.get(threadId) : undefined;

    console.log(
      `[codex] Notification: ${method}` +
        (threadId ? ` (thread: ${threadId.slice(0, 8)})` : "")
    );

    switch (method) {
      case "item/agentMessage/delta": {
        if (!fossclawId || !this.wsBridge) break;
        const delta = params.delta as string | undefined;
        if (delta) {
          this.wsBridge.injectToBrowsers(fossclawId, {
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

      case "turn/started": {
        if (!fossclawId) break;
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) {
          const mapping = this.sessions.get(fossclawId);
          if (mapping) mapping.currentTurnId = turn.id;
        }
        break;
      }

      case "turn/completed": {
        if (!fossclawId || !this.wsBridge) break;
        const turn = params.turn as { status?: string } | undefined;
        this.wsBridge.injectToBrowsers(fossclawId, {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            result: "",
            total_cost_usd: 0,
            num_turns: 1,
            is_error: turn?.status === "failed",
            session_id: fossclawId,
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

      case "error": {
        if (!fossclawId || !this.wsBridge) break;
        const errMsg =
          (params.message as string | undefined) || (params.error as string | undefined);
        if (errMsg) {
          this.wsBridge.injectToBrowsers(fossclawId, {
            type: "assistant",
            message: {
              type: "message",
              id: crypto.randomUUID(),
              role: "assistant",
              content: [{ type: "text", text: `**Codex Error:** ${errMsg}` }],
              model: "",
              stop_reason: "stop",
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
        break;
      }
    }
  }

  private nextId(): string {
    return String(++this.requestCounter);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const id = this.nextId();
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request "${method}" timed out after 30s`));
        }
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private async ensureRunning(): Promise<void> {
    if (!this.ready) await this.start();
  }

  /** List available models from Codex */
  async listModels(): Promise<CodexModel[]> {
    await this.ensureRunning();
    try {
      const result = (await this.request("model/list", {})) as {
        data?: Array<{ id?: string; model?: string; displayName?: string }>;
      };
      const models = result?.data ?? [];
      return models.map((m) => ({
        id: m.model || m.id || "",
        name: m.displayName || m.model || m.id || "",
      }));
    } catch (err) {
      console.error("[codex] Failed to list models:", err);
      return [];
    }
  }

  /** Create a Codex thread and register it as a FossClaw session */
  async createSession(fossclawId: string, cwd: string, model?: string): Promise<void> {
    // Register external handler BEFORE async work to prevent race with cli_disconnected
    if (this.wsBridge) {
      this.wsBridge.registerExternalHandler(fossclawId, (msg) =>
        this.handleBrowserMessage(fossclawId, msg as { type: string; [key: string]: unknown })
      );
    }

    await this.ensureRunning();

    const response = (await this.request("thread/start", {
      model: model || null,
      cwd: cwd || null,
      approvalPolicy: "never",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })) as { thread?: { id?: string } };

    const threadId = response?.thread?.id;
    if (!threadId) {
      throw new Error("Codex thread/start response missing thread.id");
    }

    const mapping: CodexSessionMapping = { fossclawId, threadId, cwd, model };
    this.sessions.set(fossclawId, mapping);
    this.threadToFossclaw.set(threadId, fossclawId);

    // Signal to browser that session is ready
    if (this.wsBridge) {
      this.wsBridge.injectToBrowsers(fossclawId, {
        type: "session_init",
        session: {
          session_id: fossclawId,
          model: model || "codex",
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
  }

  /** Send a user message to a Codex thread */
  async sendMessage(fossclawId: string, text: string, images?: { media_type: string; data: string }[]) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping) throw new Error(`No Codex session for ${fossclawId}`);

    const input: unknown[] = [];
    if (images?.length) {
      for (const img of images) {
        input.push({ type: "image", url: `data:${img.media_type};base64,${img.data}` });
      }
    }
    input.push({ type: "text", text, text_elements: [] });

    if (this.wsBridge) {
      this.wsBridge.injectToBrowsers(fossclawId, {
        type: "stream_event",
        event: { type: "message_start" },
        parent_tool_use_id: null,
      });
    }

    await this.request("turn/start", {
      threadId: mapping.threadId,
      input,
    });
  }

  /** Interrupt the current turn for a session */
  async abort(fossclawId: string) {
    const mapping = this.sessions.get(fossclawId);
    if (!mapping?.currentTurnId) return;
    try {
      await this.request("turn/interrupt", {
        threadId: mapping.threadId,
        turnId: mapping.currentTurnId,
      });
    } catch {
      /* best effort */
    }
  }

  isCodexSession(fossclawId: string): boolean {
    return this.sessions.has(fossclawId);
  }

  removeSession(fossclawId: string) {
    const mapping = this.sessions.get(fossclawId);
    if (mapping) {
      this.threadToFossclaw.delete(mapping.threadId);
    }
    this.sessions.delete(fossclawId);
    if (this.wsBridge) {
      this.wsBridge.unregisterExternalHandler(fossclawId);
    }
  }

  private async handleBrowserMessage(fossclawId: string, msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case "user_message": {
        const content = msg.content as string;
        const images = msg.images as { media_type: string; data: string }[] | undefined;
        if (this.wsBridge) {
          this.wsBridge.injectToBrowsers(fossclawId, { type: "status_change", status: null });
        }
        try {
          await this.sendMessage(fossclawId, content, images);
        } catch (e) {
          console.error("[codex] Failed to send message:", e);
        }
        break;
      }
      case "interrupt":
        await this.abort(fossclawId);
        break;
    }
  }

  async stop() {
    this.stopping = true;
    this.ws?.terminate();
    this.ws = null;
    if (this.proc) {
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 5000))]);
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
      } catch {
        /* stream closed */
      }
    };
    if (proc.stdout && typeof proc.stdout !== "number") pipe(proc.stdout as ReadableStream<Uint8Array>, "stdout");
    if (proc.stderr && typeof proc.stderr !== "number") pipe(proc.stderr as ReadableStream<Uint8Array>, "stderr");
  }
}
