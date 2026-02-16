import { randomUUID } from "node:crypto";

export function makeSystemInit(overrides: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "init",
    session_id: overrides.session_id ?? randomUUID(),
    cwd: overrides.cwd ?? "/tmp/test",
    model: overrides.model ?? "claude-sonnet-4-20250514",
    tools: overrides.tools ?? ["Read", "Write", "Bash"],
    permissionMode: overrides.permissionMode ?? "default",
    claude_code_version: overrides.claude_code_version ?? "1.0.0",
    mcp_servers: overrides.mcp_servers ?? [],
    agents: overrides.agents ?? [],
    slash_commands: overrides.slash_commands ?? [],
    skills: overrides.skills ?? [],
    apiKeySource: "env",
    output_style: "text",
    uuid: randomUUID(),
    ...overrides,
  };
}

export function makeAssistantMessage(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: overrides.model ?? "claude-sonnet-4-20250514",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: overrides.result ?? "done",
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: overrides.num_turns ?? 1,
    total_cost_usd: overrides.total_cost_usd ?? 0.01,
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeControlRequest(
  toolName: string,
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const requestId = (overrides.request_id as string) ?? randomUUID();
  return {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
      tool_use_id: (overrides.tool_use_id as string) ?? `toolu_${randomUUID()}`,
      description: overrides.description ?? `Use ${toolName}`,
    },
  };
}

export function makeStreamEvent(event: unknown, overrides: Record<string, unknown> = {}) {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeToolProgress(toolName: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_progress",
    tool_use_id: (overrides.tool_use_id as string) ?? `toolu_${randomUUID()}`,
    tool_name: toolName,
    parent_tool_use_id: null,
    elapsed_time_seconds: overrides.elapsed_time_seconds ?? 2.5,
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeToolUseSummary(summary: string, toolUseIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_use_summary",
    summary,
    preceding_tool_use_ids: toolUseIds,
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeAuthStatus(overrides: Record<string, unknown> = {}) {
  return {
    type: "auth_status",
    isAuthenticating: overrides.isAuthenticating ?? true,
    output: overrides.output ?? ["Authenticating..."],
    error: overrides.error,
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeSystemStatus(overrides: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "status",
    status: overrides.status ?? "compacting",
    permissionMode: overrides.permissionMode,
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}

export function makeResultMessageWithUsage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: overrides.num_turns ?? 1,
    total_cost_usd: overrides.total_cost_usd ?? 0.01,
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {
      "claude-sonnet-4-20250514": {
        inputTokens: 8000,
        outputTokens: 2000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
        costUSD: 0.01,
      },
    },
    uuid: randomUUID(),
    session_id: overrides.session_id ?? "",
    ...overrides,
  };
}
