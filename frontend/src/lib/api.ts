export type RetrievalResult = {
  text: string;
  score: number;
  source: string;
};

export type ToolCall = {
  tool: string;
  input: string;
  output: string;
};

export type RunSummary = {
  run_id: string;
  session_id?: string | null;
  status: string;
  phase: string;
  request: string;
  created_at: number;
  updated_at: number;
  created_at_iso?: string;
  updated_at_iso?: string;
  active_agent_ids?: string[];
  current_task_ids?: string[];
};

export type AgentRecord = {
  agent_id: string;
  role: string;
  label: string;
  session_key: string;
  parent_agent_id?: string | null;
  status: string;
  depth: number;
  instance: number;
  current_task_id?: string | null;
  current_phase?: string | null;
  progress: number;
  heartbeat_at: string;
  created_at: string;
  updated_at: string;
  worktree: string;
};

export type TaskRecord = {
  task_id: string;
  owner_role: string;
  title: string;
  description: string;
  phase: string;
  priority: string;
  status: string;
  progress: number;
  request: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  dependencies: string[];
  next_steps: string[];
  verify_command: string;
  latest_summary: string;
  latest_error: string;
  blocked_reason: string;
  assigned_agent_id?: string | null;
};

export type AgentHistoryEntry = {
  id: string;
  agent_id: string;
  role: "user" | "assistant" | string;
  content: string;
  timestamp: string;
  tool_calls?: Array<{ tool: string; input: string; output: string }>;
  metadata?: Record<string, unknown>;
};

export type RunEvent = {
  schema_version?: string;
  event_id: string;
  seq: number;
  type: string;
  timestamp: string;
  run_id: string;
  agent_id?: string;
  target_agent_id?: string;
  role?: string;
  task_id?: string;
  status?: string;
  phase?: string;
  progress?: number;
  title?: string;
  summary?: string;
  content?: string;
  tool?: string;
  input?: string;
  output?: string;
  error?: string;
  path?: string;
  results?: RetrievalResult[];
  status_counts?: Record<string, number>;
  [key: string]: unknown;
};

export type RunDetails = RunSummary & {
  agents: AgentRecord[];
  tasks: TaskRecord[];
};

export type StreamHandlers = {
  onEvent: (event: string, data: Record<string, unknown>) => void;
};

const DEFAULT_API_BASE = "http://127.0.0.1:8002/api";
const REQUEST_TIMEOUT_MS = 10_000;
const STREAM_CONNECT_TIMEOUT_MS = 15_000;

function normalizeApiBase(base: string) {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function getApiBase() {
  const configuredBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (configuredBase) {
    return normalizeApiBase(configuredBase);
  }

  if (typeof window === "undefined") {
    return DEFAULT_API_BASE;
  }

  return `http://${window.location.hostname}:8002/api`;
}

function toNetworkError(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error(fallback);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(fallback);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      },
      signal: controller.signal
    });
  } catch (error) {
    throw toNetworkError(
      error,
      "API request timed out. Check whether the backend is running and reachable."
    );
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function listRuns() {
  return request<RunSummary[]>("/runs");
}

export async function clearRuns() {
  return request<{ ok: boolean; removed_runs: number }>("/runs", { method: "DELETE" });
}

export async function getRun(runId: string) {
  return request<RunDetails>(`/runs/${runId}`);
}

export async function getRunEvents(runId: string, afterSeq = 0) {
  return request<{ events: RunEvent[] }>(`/runs/${runId}/events?after_seq=${afterSeq}`);
}

export async function getRunTasks(runId: string) {
  return request<{ tasks: TaskRecord[] }>(`/runs/${runId}/tasks`);
}

export async function getRunAgents(runId: string) {
  return request<{ agents: AgentRecord[] }>(`/runs/${runId}/agents`);
}

export async function getRunFiles(runId: string) {
  return request<{ files: string[] }>(`/runs/${runId}/files`);
}

export async function cancelRun(runId: string) {
  return request<RunSummary>(`/runs/${runId}/cancel`, { method: "POST" });
}

export async function resumeRun(runId: string) {
  return request<RunSummary>(`/runs/${runId}/resume`, { method: "POST" });
}

export async function getAgentHistory(runId: string, agentId: string, limit = 100) {
  return request<{ messages: AgentHistoryEntry[] }>(
    `/agents/${runId}/${agentId}/history?limit=${limit}`
  );
}

export async function getAgentStatus(runId: string, agentId: string) {
  return request<AgentRecord>(`/agents/${runId}/${agentId}/status`);
}

export async function clearSessions() {
  return request<{ removed_sessions: number; removed_archives: number }>("/sessions", {
    method: "DELETE"
  });
}

export async function listSkills() {
  return request<Array<{ name: string; description: string; path: string }>>("/skills");
}

export async function loadFile(path: string) {
  return request<{ path: string; content: string }>(
    `/files?path=${encodeURIComponent(path)}`
  );
}

export async function saveFile(path: string, content: string) {
  return request<{ ok: boolean; path: string }>("/files", {
    method: "POST",
    body: JSON.stringify({ path, content })
  });
}

export async function streamRun(
  payload: {
    message: string;
    session_id?: string | null;
  },
  handlers: StreamHandlers
) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...payload,
        stream: true
      }),
      signal: controller.signal
    });
  } catch (error) {
    throw toNetworkError(
      error,
      "Run request timed out. Check whether the backend runs API is reachable."
    );
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok || !response.body) {
    throw new Error(`Run request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBlock = (block: string) => {
    const lines = block.split("\n");
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (!dataLines.length) {
      return;
    }

    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    handlers.onEvent(event, data);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      flushBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }

    if (done) {
      if (buffer.trim()) {
        flushBlock(buffer);
      }
      break;
    }
  }
}
