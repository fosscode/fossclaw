/**
 * Mock CLI client — simulates Claude Code CLI connecting via WebSocket.
 * Speaks NDJSON (newline-delimited JSON) like the real CLI.
 */
export class MockCLIClient {
  private ws: WebSocket;
  private received: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private openPromise: Promise<void>;

  constructor(wsUrl: string, sessionId: string) {
    this.ws = new WebSocket(`${wsUrl}/ws/cli/${sessionId}`);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      const lines = data.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        if (this.waiters.length > 0) {
          this.waiters.shift()!(line);
        } else {
          this.received.push(line);
        }
      }
    };
  }

  async connect(): Promise<void> {
    await this.openPromise;
  }

  /** Send a single NDJSON line. */
  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg) + "\n");
  }

  /** Wait for the next message from the server (browser→CLI direction). */
  nextMessage(timeoutMs = 2000): Promise<Record<string, unknown>> {
    if (this.received.length > 0) {
      return Promise.resolve(JSON.parse(this.received.shift()!));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("MockCLIClient: timed out waiting for message")),
        timeoutMs,
      );
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
    });
  }

  /** Drain all buffered messages. */
  drainMessages(): Record<string, unknown>[] {
    const msgs = this.received.map((l) => JSON.parse(l));
    this.received = [];
    return msgs;
  }

  close(): void {
    try { this.ws.close(); } catch {}
  }
}
