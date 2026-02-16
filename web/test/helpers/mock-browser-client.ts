/**
 * Mock browser client — simulates a browser connecting via WebSocket.
 * Speaks plain JSON (not NDJSON).
 */
export class MockBrowserClient {
  private ws: WebSocket;
  private received: Record<string, unknown>[] = [];
  private waiters: Array<{
    resolve: (msg: Record<string, unknown>) => void;
    filter?: (msg: Record<string, unknown>) => boolean;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private openPromise: Promise<void>;

  constructor(wsUrl: string, sessionId: string) {
    this.ws = new WebSocket(`${wsUrl}/ws/browser/${sessionId}`);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      const msg = JSON.parse(data) as Record<string, unknown>;
      const idx = this.waiters.findIndex((w) => !w.filter || w.filter(msg));
      if (idx >= 0) {
        const waiter = this.waiters.splice(idx, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        this.received.push(msg);
      }
    };
  }

  async connect(): Promise<void> {
    await this.openPromise;
  }

  /** Send a JSON message to the bridge. */
  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for a message with a specific `type` field. Other messages are buffered. */
  waitForMessage(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const idx = this.received.findIndex((m) => m.type === type);
    if (idx >= 0) {
      return Promise.resolve(this.received.splice(idx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const idx = this.waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error(`MockBrowserClient: timed out waiting for "${type}"`));
        },
        timeoutMs,
      );
      this.waiters.push({
        filter: (m) => m.type === type,
        resolve,
        timer,
      });
    });
  }

  /** Wait for the next message of any type. */
  nextMessage(timeoutMs = 2000): Promise<Record<string, unknown>> {
    if (this.received.length > 0) {
      return Promise.resolve(this.received.shift()!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const idx = this.waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error("MockBrowserClient: timed out waiting for message"));
        },
        timeoutMs,
      );
      this.waiters.push({ resolve, timer });
    });
  }

  /** Get all buffered messages (non-destructive). */
  allMessages(): Record<string, unknown>[] {
    return [...this.received];
  }

  /** Drain and return all buffered messages. */
  drain(): Record<string, unknown>[] {
    const msgs = [...this.received];
    this.received = [];
    return msgs;
  }

  close(): void {
    try { this.ws.close(); } catch {}
  }
}
