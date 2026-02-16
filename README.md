# FossClaw

A web interface for Claude Code, built on a reverse-engineered WebSocket protocol from the CLI.

Launch Claude Code sessions from your browser. Stream responses in real-time. Approve tool calls. Monitor multiple agents. No API key needed — uses your existing Claude Code subscription.

## Quick Start

> **Prerequisite:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

```bash
cd web && bun install && bun run build && bun run start
```

Open [http://localhost:3456](http://localhost:3456) and start coding.

## Features

- **Multi-session management** — Launch multiple Claude Code sessions and switch between them
- **Real-time streaming** — Watch responses generate token by token over WebSocket
- **Tool call visualization** — Every tool call displayed in collapsible blocks with syntax-highlighted content
- **Interactive permission control** — Approve, deny, or edit tool inputs before they execute
- **Subagent task nesting** — Sub-agents render nested under the parent
- **Live session stats** — Track cost, context window usage, and turn count in real-time
- **Slash commands & image attachments** — Use `/` for commands, paste or upload images
- **Linear integration** — Issue-driven workflows with playbook templates
- **Dark mode** — Toggle between light and dark themes

## Architecture

### Overview

```
Browser (React on :5174)
   |
   |-- HTTP --> Vite proxy --> Hono REST API (:3456)
   |
   +-- WS /ws/browser/:id --+
                             | WsBridge (in-memory)
   Claude CLI <-- WS /ws/cli/:id --+
         ^
    Bun.spawn() by CliLauncher
```

Claude Code CLI has a hidden `--sdk-url` flag that makes it connect to an external WebSocket server instead of running in a terminal. FossClaw exploits this by spawning CLI processes that connect *back* to the server, while browsers connect on a separate WebSocket endpoint. The `WsBridge` sits in the middle and routes messages between them.

### How Bun Is Used

Bun is the **runtime**, not just a package manager. The server uses `Bun.serve()` with native WebSocket support — no `ws` or `socket.io` needed. WebSocket upgrades are handled directly in the `fetch` handler, and each connection gets tagged with metadata (`{kind: "cli", sessionId}` or `{kind: "browser", sessionId}`) so the bridge knows which side it's talking to.

Bun also spawns Claude Code CLI processes via `Bun.spawn()` — native Bun API, no `child_process` needed.

### Two Processes in Dev, One in Prod

**Development** — two separate processes:
1. `bun --watch server/index.ts` (port 3456) — the backend
2. `vite` (port 5174) — the frontend dev server with HMR

Vite proxies `/api/*` and `/ws/*` to the Bun server. You open `localhost:5174`.

**Production** — one process:
- `bun server/index.ts` serves the Hono REST API, WebSockets, *and* the Vite-built static files from `dist/` — all on port 3456.

### WebSocket Bridge

Two WebSocket endpoints on the same server:

| Endpoint | Who connects | Protocol |
|----------|-------------|----------|
| `/ws/cli/:sessionId` | Claude Code CLI | NDJSON (newline-delimited JSON) |
| `/ws/browser/:sessionId` | Browser | JSON |

`WsBridge` translates between them and handles:
- **Message routing** — CLI messages are transformed and broadcast to all connected browsers
- **Message queuing** — If the browser sends before the CLI connects, messages are queued and flushed when the CLI is ready
- **Permission flow** — CLI sends `control_request`, browser responds with allow/deny, bridge forwards to CLI
- **History replay** — New browser clients receive the full message history on connect
- **Multi-browser** — Multiple browsers can connect to the same session simultaneously

### In-Memory State

There is no database. All state lives in JS `Map`s inside the Bun process:

**`WsBridge`** holds per-session:
- `cliSocket` / `browserSockets` — live WebSocket connections
- `state` — model, cwd, cost, turns, context usage
- `messageHistory` — all messages for replay
- `pendingPermissions` — unanswered permission requests
- `pendingMessages` — queue for messages sent before CLI connects

**`CliLauncher`** holds per-session:
- `SdkSessionInfo` — session metadata (ID, state, model, cwd, PID)
- `Subprocess` — the spawned CLI process handle

If the Bun process dies, all state is lost. Browser-side persistence (localStorage) covers dark mode, sidebar width, session names, and playbooks.

### Hono's Role

Hono is a lightweight web framework handling the REST API (`/api/sessions/*`, `/api/fs/*`, `/api/linear/*`) and static file serving. It does **not** handle WebSockets — those are intercepted in the `fetch` function before being passed to Hono.

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sessions/create` | Spawn a new Claude Code CLI session |
| GET | `/api/sessions` | List all active sessions |
| GET | `/api/sessions/:id` | Get session details |
| POST | `/api/sessions/:id/kill` | Kill a session's CLI process |
| DELETE | `/api/sessions/:id` | Kill + remove a session |
| GET | `/api/fs/list?path=` | Browse directories |
| GET | `/api/fs/home` | Get home dir + default CWD |
| GET | `/api/linear/issues` | Search Linear issues |
| GET | `/api/linear/teams` | List Linear teams |
| GET | `/api/linear/labels` | List labels |
| GET | `/api/linear/cycles?team=` | List cycles |
| GET | `/api/linear/states?team=` | List states |
| GET | `/api/linear/members?team=` | List members |
| GET | `/api/opencode/models` | List OpenCode models |

### Project Structure

```
web/
  server/
    index.ts           -- Server bootstrap, Bun.serve() + WebSocket handlers
    routes.ts          -- Hono REST API routes
    ws-bridge.ts       -- CLI <-> Browser bidirectional bridge
    cli-launcher.ts    -- Process spawning and session tracking
    session-types.ts   -- Protocol type definitions
    linear-client.ts   -- Linear GraphQL client
    opencode-bridge.ts -- OpenCode HTTP+SSE bridge
  src/
    main.tsx           -- React root
    App.tsx            -- Layout, routing, modals
    store.ts           -- Zustand state management
    ws.ts              -- WebSocket client, message routing
    api.ts             -- Typed REST client
    types.ts           -- Frontend types
    components/
      HomePage.tsx     -- Session launcher UI
      ChatView.tsx     -- Message feed + composer
      Sidebar.tsx      -- Sessions + Linear issues
      Composer.tsx     -- User input + slash commands
      MessageFeed.tsx  -- Renders messages with streaming
      MessageBubble.tsx -- Single message rendering
      ToolBlock.tsx    -- Tool use visualization
      PermissionBanner.tsx -- Permission request UI
      TopBar.tsx       -- Stats, model switcher, dark mode
      TaskPanel.tsx    -- Todo list from agent tasks
      LinearIssueList.tsx  -- Issue search/filter
      PlaybookSelector.tsx -- Playbook picker modal
      PlaybookManager.tsx  -- CRUD playbooks
    utils/
      names.ts         -- Session name generation
      playbook.ts      -- Template rendering
  test/
    helpers/           -- Test utilities
    rest-api.test.ts   -- REST endpoint tests
    ws-bridge.test.ts  -- WebSocket bridge tests
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Server | Hono + native Bun WebSocket |
| Frontend | React 19 + TypeScript |
| State | Zustand |
| Styling | Tailwind CSS v4 |
| Build | Vite |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3456 | Server port |
| `FOSSCLAW_CWD` | `process.cwd()` | Default working directory for sessions |
| `FOSSCLAW_USER` | — | Username for form-based auth (both required) |
| `FOSSCLAW_PASS` | — | Password for form-based auth (both required) |
| `FOSSCLAW_HTTPS` | `false` | Set to `"true"` to enable HTTPS with self-signed certificates |
| `FOSSCLAW_HTTPS_HOSTNAME` | `"localhost"` | Hostname for certificate generation |
| `FOSSCLAW_CERT_DIR` | `~/.fossclaw/certs` | Directory to store/find TLS certificates |
| `FOSSCLAW_SESSION_DIR` | `~/.fossclaw/sessions` | Session storage path (share across instances) |
| `LINEAR_API_KEY` | — | Linear API key for issue integration |
| `OPENCODE_PORT` | PORT+100 | Port for OpenCode serve process |
| `OLLAMA_URL` | — | Ollama service URL for auto-naming sessions (e.g., `http://localhost:11434`) |
| `OLLAMA_MODEL` | `llama3.2:3b` | Ollama model to use for session naming |

## Development

```bash
cd web
bun install
bun run dev          # server on :3456
bun run dev:vite     # Vite on :5174 (separate terminal)
```

Open [http://localhost:5174](http://localhost:5174) for hot-reloading development.

### Git Hooks

Install pre-push hooks for security and quality checks:

```bash
./setup-hooks.sh
```

The pre-push hook automatically:
- Detects secrets (API keys, passwords, private keys)
- Validates `.gitignore` configuration
- Rewrites Claude-authored commits to FossCode
- Runs TypeScript type checks
- Runs linter (if configured)
- Executes test suite

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## Testing

```bash
cd web
bun test
```

Tests use `bun:test` with a real `Bun.serve()` on ephemeral ports and mock WebSocket clients. No external dependencies needed. See `web/test/` for the test suite.

## Building & Releases

### Standalone Binaries

Build self-contained executables for distribution:

```bash
# Build for current platform
./build.sh

# Create GitHub release
./release.sh 2.3.0
```

Binaries include everything needed to run (frontend, server, dependencies) in a single ~57MB executable (~21MB compressed).

**Platform Support:**
- macOS (ARM64, x64)
- Linux (x64)
- Windows (x64)

See [BUILD.md](./BUILD.md) for detailed build instructions and [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) for release workflow.

## License

MIT
