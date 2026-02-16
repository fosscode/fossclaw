import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSessionStore } from "../server/session-store.js";
import { WsBridge } from "../server/ws-bridge.js";
import type { PersistedMeta } from "../server/session-store.js";
import type { SessionState, BrowserIncomingMessage } from "../server/session-types.js";

function makeMeta(overrides: Partial<PersistedMeta> = {}): PersistedMeta {
  return {
    sessionId: "test-session-1",
    pid: 12345,
    model: "claude-sonnet-4-5-20250929",
    permissionMode: "default",
    provider: "claude",
    cwd: "/tmp/test",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session-1",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/tmp/test",
    tools: ["Read", "Write", "Bash"],
    permissionMode: "default",
    claude_code_version: "1.0.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0.05,
    num_turns: 3,
    context_used_percent: 15,
    is_compacting: false,
    ...overrides,
  };
}

function makeHistory(): BrowserIncomingMessage[] {
  return [
    { type: "user_message", content: "Hello", timestamp: Date.now() },
    {
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hi there!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    },
  ];
}

let tmpDir: string;
let store: FileSessionStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "fossclaw-test-"));
  store = new FileSessionStore(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  test("save + load round-trip for meta", async () => {
    const meta = makeMeta();
    store.saveMeta("s1", meta);
    await store.flush();

    const loaded = await store.load("s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.sessionId).toBe(meta.sessionId);
    expect(loaded!.meta.pid).toBe(meta.pid);
    expect(loaded!.meta.model).toBe(meta.model);
    expect(loaded!.meta.cwd).toBe(meta.cwd);
  });

  test("save + load round-trip for state", async () => {
    const meta = makeMeta();
    const state = makeState();
    store.saveMeta("s1", meta);
    store.saveState("s1", state);
    await store.flush();

    const loaded = await store.load("s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.state.model).toBe(state.model);
    expect(loaded!.state.total_cost_usd).toBe(0.05);
    expect(loaded!.state.num_turns).toBe(3);
    expect(loaded!.state.tools).toEqual(["Read", "Write", "Bash"]);
  });

  test("save + load round-trip for history", async () => {
    const meta = makeMeta();
    const history = makeHistory();
    store.saveMeta("s1", meta);
    store.saveHistory("s1", history);
    await store.flush();

    const loaded = await store.load("s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.history).toHaveLength(2);
    expect(loaded!.history[0].type).toBe("user_message");
    expect(loaded!.history[1].type).toBe("assistant");
  });

  test("load returns null for nonexistent session", async () => {
    const loaded = await store.load("nonexistent");
    expect(loaded).toBeNull();
  });

  test("load returns default state when state.json missing", async () => {
    const meta = makeMeta({ sessionId: "s2" });
    store.saveMeta("s2", meta);
    await store.flush();

    const loaded = await store.load("s2");
    expect(loaded).not.toBeNull();
    expect(loaded!.state.session_id).toBe("s2");
    expect(loaded!.state.total_cost_usd).toBe(0);
    expect(loaded!.history).toEqual([]);
  });

  test("loadAll returns multiple sessions", async () => {
    store.saveMeta("s1", makeMeta({ sessionId: "s1" }));
    store.saveMeta("s2", makeMeta({ sessionId: "s2" }));
    store.saveMeta("s3", makeMeta({ sessionId: "s3" }));
    await store.flush();

    const all = await store.loadAll();
    expect(all).toHaveLength(3);
    const ids = all.map((s) => s.meta.sessionId).sort();
    expect(ids).toEqual(["s1", "s2", "s3"]);
  });

  test("remove deletes session directory", async () => {
    store.saveMeta("s1", makeMeta());
    await store.flush();

    // Verify it exists
    let loaded = await store.load("s1");
    expect(loaded).not.toBeNull();

    await store.remove("s1");

    // Verify it's gone
    loaded = await store.load("s1");
    expect(loaded).toBeNull();
  });

  test("remove cancels pending writes", async () => {
    store.saveMeta("s1", makeMeta());
    // Don't flush — remove before the debounced write fires
    await store.remove("s1");
    await store.flush();

    const loaded = await store.load("s1");
    expect(loaded).toBeNull();
  });

  test("flush writes all pending data immediately", async () => {
    store.saveMeta("s1", makeMeta());
    store.saveState("s1", makeState());
    store.saveHistory("s1", makeHistory());
    // Nothing on disk yet (debounced)

    await store.flush();

    // Verify files exist
    const dir = join(tmpDir, "s1");
    const files = await readdir(dir);
    expect(files.sort()).toEqual(["history.json", "meta.json", "state.json"]);
  });

  test("atomic writes produce valid JSON", async () => {
    const meta = makeMeta();
    store.saveMeta("s1", meta);
    await store.flush();

    const raw = await readFile(join(tmpDir, "s1", "meta.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessionId).toBe(meta.sessionId);
  });

  test("overwriting data preserves latest version", async () => {
    store.saveState("s1", makeState({ total_cost_usd: 0.01 }));
    store.saveMeta("s1", makeMeta());
    await store.flush();

    store.saveState("s1", makeState({ total_cost_usd: 0.99 }));
    await store.flush();

    const loaded = await store.load("s1");
    expect(loaded!.state.total_cost_usd).toBe(0.99);
  });
});

describe("WsBridge + FileSessionStore integration", () => {
  let tmpDir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fossclaw-bridge-test-"));
    store = new FileSessionStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("bridge restoreSession then removeSession cleans up store", async () => {
    const state = makeState({ session_id: "int-1" });
    const history = makeHistory();

    // Save data to the store first (simulating prior server run)
    store.saveMeta("int-1", makeMeta({ sessionId: "int-1" }));
    store.saveState("int-1", state);
    store.saveHistory("int-1", history);
    await store.flush();

    // Create bridge with the store
    const bridge = new WsBridge(store);
    bridge.restoreSession("int-1", state, history);

    // Verify session exists in bridge
    const session = bridge.getSession("int-1");
    expect(session).toBeDefined();

    // Remove — should clear from both bridge and store
    bridge.removeSession("int-1");
    expect(bridge.getSession("int-1")).toBeUndefined();

    // Give the async store.remove() time to complete
    await new Promise((r) => setTimeout(r, 100));

    // Store should no longer have the session
    const loaded = await store.load("int-1");
    expect(loaded).toBeNull();
  });

  test("bridge persists state on system init via store", async () => {
    const bridge = new WsBridge(store);
    const session = bridge.getOrCreateSession("persist-1");

    // Save meta first (load requires meta.json to exist)
    store.saveMeta("persist-1", makeMeta({ sessionId: "persist-1" }));

    // Simulate a system init message coming through
    session.state.model = "opus";
    session.state.cwd = "/test/path";
    store.saveState("persist-1", session.state);
    await store.flush();

    const loaded = await store.load("persist-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.state.model).toBe("opus");
    expect(loaded!.state.cwd).toBe("/test/path");
  });

  test("bridge persists history on message via store", async () => {
    const bridge = new WsBridge(store);
    const session = bridge.getOrCreateSession("hist-1");

    // Simulate messages being added to history
    session.messageHistory.push(
      { type: "user_message", content: "Hello", timestamp: Date.now() },
    );
    store.saveHistory("hist-1", session.messageHistory);

    session.messageHistory.push(
      { type: "assistant", message: { id: "m1", type: "message", role: "assistant", model: "opus", content: [{ type: "text", text: "Hi!" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, parent_tool_use_id: null },
    );
    store.saveHistory("hist-1", session.messageHistory);
    await store.flush();

    const loaded = await store.load("hist-1");
    // Need meta for load to work
    expect(loaded).toBeNull(); // No meta saved, so load returns null

    // Save meta too and retry
    store.saveMeta("hist-1", makeMeta({ sessionId: "hist-1" }));
    await store.flush();

    const loaded2 = await store.load("hist-1");
    expect(loaded2).not.toBeNull();
    expect(loaded2!.history).toHaveLength(2);
    expect(loaded2!.history[0].type).toBe("user_message");
    expect(loaded2!.history[1].type).toBe("assistant");
  });
});
