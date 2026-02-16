# FossClaw

Web UI for Claude Code agents. Based on the reverse-engineered Claude Code WebSocket protocol.

## Development

```bash
cd web
bun install
bun run dev          # server on :3456
bun run dev:vite     # Vite on :5174 (separate terminal)
```

Open http://localhost:5174 for hot-reloading development.

## Production

```bash
cd web
bun run build && bun run start   # everything on :3456
```

## Deployment

Two deployment scripts are available:

**FossClaw (Regular)** - Port 3456
```bash
./deploy-fossclaw.sh
```
- Target: `../fossclaw`
- Port: 3456 (OpenCode: 3556)
- Log: `~/.fossclaw/server-fossclaw.log`

**FossClaw Stable** - Port 3457
```bash
./deploy-stable-fossclaw.sh
```
- Target: `../fossclaw-stable`
- Port: 3457 (OpenCode: 3557)
- Log: `~/.fossclaw/server-stable.log`

Both scripts:
1. Clone repo to target directory if it doesn't exist
2. Pull latest changes from source
3. Install dependencies and build frontend
4. Stop any running instance on target port
5. Start new server in background

## Testing

```bash
cd web
bun test
```

Tests use `bun:test` with ephemeral-port servers and mock WebSocket clients. No external deps.

## Architecture

- **Runtime**: Bun (runs TypeScript directly, no transpile step for server)
- **Server**: `Bun.serve()` with native WebSocket + Hono for REST routes
- **Frontend**: React 19 + TypeScript + Zustand + Tailwind CSS v4
- **Build**: Vite (dev server on :5174 proxies `/api` and `/ws` to :3456)
- **State**: All in-memory (`Map`s in WsBridge and CliLauncher). No database.

## Key Server Files

- `server/index.ts` — Entrypoint. `Bun.serve()` handles WS upgrades before passing to Hono.
- `server/ws-bridge.ts` — Core logic. Routes NDJSON from CLI to JSON for browsers. Handles queuing, permissions, history replay.
- `server/cli-launcher.ts` — Spawns `claude --sdk-url ws://...` via `Bun.spawn()`. Tracks session state machine.
- `server/routes.ts` — Hono REST API. `createRoutes(launcher, bridge, cwd)` is injectable for testing.
- `server/session-types.ts` — All CLI and browser message type definitions.

## WebSocket Protocol

CLI speaks NDJSON (newline-delimited JSON), browser speaks plain JSON. Two endpoints:
- `/ws/cli/:sessionId` — CLI connects here (no auth)
- `/ws/browser/:sessionId` — Browser connects here (auth checked if configured)

## Environment Variables

- `PORT` (default 3456)
- `FOSSCLAW_CWD` — default working directory for new sessions
- `FOSSCLAW_SESSION_DIR` — session storage path (default `~/.fossclaw/sessions`). Set to same path across instances to share sessions.
- `FOSSCLAW_SESSION_TTL_DAYS` — how long to keep inactive sessions in days (default 7, set to 0 to disable cleanup)
- `FOSSCLAW_USER` + `FOSSCLAW_PASS` — basic auth (both required to enable)
- `FOSSCLAW_HTTPS` — set to `"true"` to enable HTTPS with self-signed certificates
- `FOSSCLAW_HTTPS_HOSTNAME` — hostname for certificate generation (default `"localhost"`)
- `FOSSCLAW_CERT_DIR` — directory to store/find TLS certificates (default `~/.fossclaw/certs`)
- `LINEAR_API_KEY` — for Linear integration endpoints
- `OPENCODE_PORT` — for OpenCode bridge (default PORT+100)
- `OLLAMA_URL` — Ollama service URL for auto-naming sessions (e.g., `http://localhost:11434`)
- `OLLAMA_MODEL` — Ollama model to use for naming (default `llama3.2:3b`)

## Session Persistence

Sessions are automatically persisted to disk and restored on server restart:

- **Active sessions**: If the CLI process is still running, sessions reconnect automatically
- **Archived sessions**: If the CLI died, sessions are restored as read-only with "Archived" label
- **Resume feature**: Archived sessions can be resumed via the resume button (▶️ icon) in the sidebar, which spawns a new CLI with `--resume` flag
- **Activity tracking**: Sessions track `lastActivityAt` timestamp for cleanup
- **Auto-cleanup**: Inactive archived sessions are removed after TTL expires (configurable via `FOSSCLAW_SESSION_TTL_DAYS`)

## Git Commit Guidelines

- Do NOT attribute commits to Claude, Anthropic, or any AI assistant
- Commits should be attributed to FossCode or individual contributors only
- Pre-commit hooks enforce this automatically
