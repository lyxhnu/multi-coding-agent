"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import {
  cancelRun,
  clearRuns as clearRunsApi,
  clearSessions as clearSessionsApi,
  getAgentHistory,
  getRagMode,
  getRun,
  getRunEvents,
  getRunFiles,
  listRuns,
  listSkills,
  loadFile,
  resumeRun,
  saveFile,
  setRagMode,
  streamRun,
  streamRunFollowup,
  type AgentHistoryEntry,
  type AgentRecord,
  type RunDetails,
  type RunEvent,
  type RunSummary,
  type TaskRecord
} from "@/lib/api";

type AppStore = {
  runs: RunSummary[];
  currentRunId: string | null;
  currentRun: RunSummary | null;
  agents: AgentRecord[];
  tasks: TaskRecord[];
  events: RunEvent[];
  selectedAgentId: string | null;
  selectedAgentHistory: AgentHistoryEntry[];
  isStreaming: boolean;
  ragModeEnabled: boolean;
  ragModeBusy: boolean;
  appError: string | null;
  appNotice: string | null;
  inspectorError: string | null;
  skills: Array<{ name: string; description: string; path: string }>;
  editableFiles: string[];
  runFiles: string[];
  inspectorPath: string;
  inspectorContent: string;
  inspectorDirty: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  submitPrompt: (value: string) => Promise<void>;
  startRun: (value: string) => Promise<void>;
  startNewRun: (value: string) => Promise<void>;
  prepareNewRun: () => void;
  selectRun: (runId: string) => Promise<void>;
  cancelCurrentRun: () => Promise<void>;
  resumeCurrentRun: () => Promise<void>;
  clearAllRuns: () => Promise<void>;
  clearAllSessions: () => Promise<void>;
  toggleRagMode: () => Promise<void>;
  selectAgent: (agentId: string | null) => Promise<void>;
  loadInspectorFile: (path: string) => Promise<void>;
  updateInspectorContent: (value: string) => void;
  saveInspector: () => Promise<void>;
  refreshCurrentRun: () => Promise<void>;
  setSidebarWidth: (width: number) => void;
  setInspectorWidth: (width: number) => void;
};

const FIXED_FILES = [
  "AGENTS.md",
  "README.md",
  "backend/workspace/AGENTS.md",
  "backend/memory/MEMORY.md",
  "backend/SKILLS_SNAPSHOT.md"
];

const StoreContext = createContext<AppStore | null>(null);

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

function mergeById<T extends { [key: string]: unknown }>(
  items: T[],
  next: T,
  key: keyof T
) {
  const value = next[key];
  const index = items.findIndex((item) => item[key] === value);
  if (index < 0) {
    return [...items, next];
  }
  const clone = [...items];
  clone[index] = { ...clone[index], ...next };
  return clone;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<RunSummary | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedAgentHistory, setSelectedAgentHistory] = useState<AgentHistoryEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [ragModeEnabled, setRagModeEnabled] = useState(false);
  const [ragModeBusy, setRagModeBusy] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [appNotice, setAppNotice] = useState<string | null>(null);
  const [inspectorError, setInspectorError] = useState<string | null>(null);
  const [skills, setSkills] = useState<Array<{ name: string; description: string; path: string }>>([]);
  const [runFiles, setRunFiles] = useState<string[]>([]);
  const [inspectorPath, setInspectorPath] = useState("AGENTS.md");
  const [inspectorContent, setInspectorContent] = useState("");
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const [inspectorWidth, setInspectorWidth] = useState(380);
  const currentRunIdRef = useRef<string | null>(null);
  const currentRunRef = useRef<RunSummary | null>(null);
  const agentsRef = useRef<AgentRecord[]>([]);
  const tasksRef = useRef<TaskRecord[]>([]);
  const eventsRef = useRef<RunEvent[]>([]);

  const editableFiles = useMemo(() => {
    const merged = new Set([...FIXED_FILES, ...skills.map((skill) => skill.path), ...runFiles]);
    return Array.from(merged);
  }, [skills, runFiles]);

  useEffect(() => {
    currentRunIdRef.current = currentRunId;
  }, [currentRunId]);

  useEffect(() => {
    currentRunRef.current = currentRun;
  }, [currentRun]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  function upsertRun(next: RunSummary) {
    setRuns((prev) => {
      const merged = mergeById(prev, next, "run_id");
      currentRunRef.current =
        currentRunIdRef.current === next.run_id || !currentRunIdRef.current
          ? ({ ...(currentRunRef.current ?? {}), ...next } as RunSummary)
          : currentRunRef.current;
      return merged.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    });
    if (currentRunIdRef.current === next.run_id || !currentRunIdRef.current) {
      setCurrentRun((prev) => ({ ...(prev ?? {}), ...next } as RunSummary));
    }
  }

  function upsertAgent(next: AgentRecord) {
    setAgents((prev) => {
      const merged = mergeById(prev, next, "agent_id");
      agentsRef.current = merged;
      return merged;
    });
  }

  function upsertTask(next: TaskRecord) {
    setTasks((prev) => {
      const merged = mergeById(prev, next, "task_id");
      tasksRef.current = merged;
      return merged;
    });
  }

  function appendEvent(next: RunEvent) {
    setEvents((prev) => {
      const merged = mergeById(prev, next, "event_id");
      const sorted = merged.sort((a, b) => a.seq - b.seq);
      eventsRef.current = sorted;
      return sorted;
    });
  }

  async function resetInspectorToDefault() {
    const file = await loadFile("AGENTS.md");
    setInspectorPath(file.path);
    setInspectorContent(file.content);
    setInspectorDirty(false);
    setInspectorError(null);
  }

  async function refreshRuns() {
    setRuns(await listRuns());
  }

  async function refreshRagMode() {
    const response = await getRagMode();
    setRagModeEnabled(Boolean(response.enabled));
  }

  async function refreshCurrentRun() {
    if (!currentRunId) {
      return;
    }
    const [details, eventResponse, fileResponse] = await Promise.all([
      getRun(currentRunId),
      getRunEvents(currentRunId),
      getRunFiles(currentRunId)
    ]);
    applyRunDetails(details, eventResponse.events, fileResponse.files);
  }

  function applyRunDetails(details: RunDetails, nextEvents: RunEvent[], files: string[]) {
    setCurrentRunId(details.run_id);
    currentRunIdRef.current = details.run_id;
    setCurrentRun(details);
    currentRunRef.current = details;
    setAgents(details.agents ?? []);
    agentsRef.current = details.agents ?? [];
    setTasks(details.tasks ?? []);
    tasksRef.current = details.tasks ?? [];
    const sortedEvents = nextEvents.sort((a, b) => a.seq - b.seq);
    setEvents(sortedEvents);
    eventsRef.current = sortedEvents;
    setRunFiles(files);
    upsertRun(details);
    const firstAgentId = details.agents?.[0]?.agent_id ?? null;
    setSelectedAgentId((prev) => prev ?? firstAgentId);
  }

  async function selectRun(runId: string) {
    const [details, eventResponse, fileResponse] = await Promise.all([
      getRun(runId),
      getRunEvents(runId),
      getRunFiles(runId)
    ]);
    applyRunDetails(details, eventResponse.events, fileResponse.files);
    setAppError(null);

    if (details.agents?.length) {
      await selectAgent(details.agents[0].agent_id, runId);
    } else {
      setSelectedAgentId(null);
      setSelectedAgentHistory([]);
    }
  }

  async function selectAgent(agentId: string | null, runIdOverride?: string) {
    setSelectedAgentId(agentId);
    const runId = runIdOverride ?? currentRunIdRef.current;
    if (!runId || !agentId) {
      setSelectedAgentHistory([]);
      return;
    }
    const response = await getAgentHistory(runId, agentId);
    setSelectedAgentHistory(response.messages);
  }

  function patchFromEvent(eventType: string, data: Record<string, unknown>) {
    const runId = String(data.run_id ?? currentRunIdRef.current ?? "");
    if (!runId) {
      return;
    }

    if (!currentRunIdRef.current) {
      setCurrentRunId(runId);
    }

    const eventRecord: RunEvent = {
      ...(data as RunEvent),
      event_id: String(data.event_id ?? `${eventType}-${Date.now()}`),
      seq: Number(data.seq ?? eventsRef.current.length + 1),
      type: eventType,
      timestamp: String(data.timestamp ?? new Date().toISOString()),
      run_id: runId
    };
    appendEvent(eventRecord);

    if (
      eventType === "run_created" ||
      eventType === "run_started" ||
      eventType === "run_complete" ||
      eventType === "run_blocked" ||
      eventType === "run_cancelled" ||
      eventType === "followup_started" ||
      eventType === "followup_planned" ||
      eventType === "user_message" ||
      eventType === "assistant_message"
    ) {
      upsertRun({
        run_id: runId,
        session_id: null,
        status: String(data.status ?? currentRunRef.current?.status ?? "queued"),
        phase: String(data.phase ?? currentRunRef.current?.phase ?? "startup"),
        request: currentRunRef.current?.request ?? "",
        created_at: currentRunRef.current?.created_at ?? Date.now() / 1000,
        updated_at: Date.now() / 1000
      });
    }

    if (eventType === "agent_spawned" || eventType === "agent_status" || eventType === "agent_dispatch") {
      const existing = agentsRef.current.find((item) => item.agent_id === data.agent_id);
      if (data.agent_id) {
        upsertAgent({
          agent_id: String(data.agent_id),
          role: String(data.role ?? existing?.role ?? "AGENT"),
          label: String(data.role ?? existing?.label ?? "agent").toLowerCase(),
          session_key: String(data.session_key ?? existing?.session_key ?? ""),
          parent_agent_id: existing?.parent_agent_id ?? null,
          status: String(data.status ?? (eventType === "agent_dispatch" ? "in_progress" : existing?.status ?? "idle")),
          depth: existing?.depth ?? 0,
          instance: existing?.instance ?? 1,
          current_task_id: String(data.task_id ?? existing?.current_task_id ?? ""),
          current_phase: String(data.phase ?? existing?.current_phase ?? ""),
          progress: Number(data.progress ?? existing?.progress ?? 0),
          heartbeat_at: String(data.timestamp ?? existing?.heartbeat_at ?? ""),
          created_at: existing?.created_at ?? String(data.timestamp ?? ""),
          updated_at: String(data.timestamp ?? ""),
          worktree: String(data.worktree ?? existing?.worktree ?? "")
        });
      }
    }

    if (eventType === "task_update" || eventType === "agent_dispatch") {
      const existing = tasksRef.current.find((item) => item.task_id === data.task_id);
      if (existing && data.task_id) {
        upsertTask({
          ...existing,
          status: String(data.status ?? (eventType === "agent_dispatch" ? "in_progress" : existing.status)),
          progress: Number(data.progress ?? (eventType === "agent_dispatch" ? 10 : existing.progress)),
          assigned_agent_id: String(data.agent_id ?? existing.assigned_agent_id ?? ""),
          updated_at: String(data.timestamp ?? existing.updated_at)
        });
      }
    }
  }

  async function launchNewRun(value: string) {
    if (!value.trim() || isStreaming) {
      return;
    }

    setIsStreaming(true);
    setAppError(null);
    setAppNotice(null);
    setCurrentRun(null);
    setCurrentRunId(null);
    setAgents([]);
    setTasks([]);
    setEvents([]);
    setRunFiles([]);
    setSelectedAgentId(null);
    setSelectedAgentHistory([]);

    let activeRunId: string | null = null;

    try {
      await streamRun(
        { message: value.trim(), session_id: null },
        {
          onEvent(event, data) {
            const nextRunId = String(data.run_id ?? "");
            if (nextRunId && !activeRunId) {
              activeRunId = nextRunId;
              void selectRun(nextRunId);
            }
            patchFromEvent(event, data);
          }
        }
      );
      await refreshRuns();
      if (activeRunId) {
        await selectRun(activeRunId);
      }
      setAppError(null);
    } catch (error) {
      setAppError(toErrorMessage(error, "Unable to start the multi-agent run."));
    } finally {
      setIsStreaming(false);
    }
  }

  async function continueCurrentRun(value: string) {
    const runId = currentRunIdRef.current;
    if (!value.trim() || isStreaming || !runId) {
      return;
    }

    setIsStreaming(true);
    setAppError(null);
    setAppNotice(null);

    try {
      await streamRunFollowup(
        runId,
        { message: value.trim() },
        {
          onEvent(event, data) {
            patchFromEvent(event, data);
          }
        }
      );
      await refreshRuns();
      await selectRun(runId);
      setAppError(null);
    } catch (error) {
      setAppError(toErrorMessage(error, "Unable to continue the current run."));
    } finally {
      setIsStreaming(false);
    }
  }

  async function submitPrompt(value: string) {
    if (currentRunIdRef.current) {
      await continueCurrentRun(value);
      return;
    }
    await launchNewRun(value);
  }

  function prepareNewRun() {
    if (isStreaming) {
      return;
    }
    setCurrentRunId(null);
    currentRunIdRef.current = null;
    setCurrentRun(null);
    currentRunRef.current = null;
    setAgents([]);
    agentsRef.current = [];
    setTasks([]);
    tasksRef.current = [];
    setEvents([]);
    eventsRef.current = [];
    setRunFiles([]);
    setSelectedAgentId(null);
    setSelectedAgentHistory([]);
    setAppError(null);
    setAppNotice("Ready to start a fresh run.");
  }

  async function cancelCurrentRun() {
    if (!currentRunId) {
      return;
    }
    setAppNotice(null);
    await cancelRun(currentRunId);
    await refreshCurrentRun();
  }

  async function resumeCurrentRun() {
    if (!currentRunId) {
      return;
    }
    setAppNotice(null);
    await resumeRun(currentRunId);
    await refreshCurrentRun();
  }

  async function clearAllRuns() {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "Clear all multi-agent run history? This removes run logs and task boards, but keeps generated APP projects."
      );
      if (!confirmed) {
        return;
      }
    }

    try {
      const response = await clearRunsApi();
      setRuns([]);
      setCurrentRunId(null);
      currentRunIdRef.current = null;
      setCurrentRun(null);
      currentRunRef.current = null;
      setAgents([]);
      agentsRef.current = [];
      setTasks([]);
      tasksRef.current = [];
      setEvents([]);
      eventsRef.current = [];
      setRunFiles([]);
      setSelectedAgentId(null);
      setSelectedAgentHistory([]);
      setAppError(null);
      setAppNotice(`Cleared ${response.removed_runs} run records.`);
      await resetInspectorToDefault();
    } catch (error) {
      setAppError(toErrorMessage(error, "Unable to clear run history."));
    }
  }

  async function clearAllSessions() {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "Clear all single-agent session history and archived session files?"
      );
      if (!confirmed) {
        return;
      }
    }

    try {
      const response = await clearSessionsApi();
      setAppError(null);
      setAppNotice(
        `Cleared ${response.removed_sessions} sessions and ${response.removed_archives} archived files.`
      );
    } catch (error) {
      setAppError(toErrorMessage(error, "Unable to clear session history."));
    }
  }

  async function toggleRagMode() {
    if (ragModeBusy) {
      return;
    }

    setRagModeBusy(true);
    try {
      const response = await setRagMode(!ragModeEnabled);
      const enabled = Boolean(response.enabled);
      setRagModeEnabled(enabled);
      setAppError(null);
      setAppNotice(`RAG mode ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      setAppError(toErrorMessage(error, "Unable to update RAG mode."));
    } finally {
      setRagModeBusy(false);
    }
  }

  async function loadInspectorFile(path: string) {
    setInspectorPath(path);
    setInspectorError(null);
    try {
      const file = await loadFile(path);
      setInspectorContent(file.content);
      setInspectorDirty(false);
      setAppError(null);
    } catch (error) {
      setInspectorContent("");
      setInspectorDirty(false);
      const errorMessage = toErrorMessage(error, `Unable to load ${path}.`);
      setInspectorError(errorMessage);
      setAppError(errorMessage);
    }
  }

  function updateInspectorContent(value: string) {
    setInspectorContent(value);
    setInspectorDirty(true);
  }

  async function saveInspector() {
    try {
      await saveFile(inspectorPath, inspectorContent);
      setInspectorDirty(false);
      setInspectorError(null);
      setAppError(null);
      await Promise.all([refreshCurrentRun(), listSkills().then(setSkills)]);
      setAppNotice(`Saved ${inspectorPath}.`);
    } catch (error) {
      const errorMessage = toErrorMessage(error, `Unable to save ${inspectorPath}.`);
      setInspectorError(errorMessage);
      setAppError(errorMessage);
      throw error;
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [initialRuns, initialSkills, initialFile] = await Promise.all([
          listRuns(),
          listSkills(),
          loadFile("AGENTS.md")
        ]);
        setRuns(initialRuns);
        setSkills(initialSkills);
        setInspectorPath(initialFile.path);
        setInspectorContent(initialFile.content);
        try {
          await refreshRagMode();
        } catch {
          setRagModeEnabled(false);
        }
        if (initialRuns.length) {
          await selectRun(initialRuns[0].run_id);
        }
        setAppError(null);
        setAppNotice(null);
        setInspectorError(null);
      } catch (error) {
        const message = toErrorMessage(
          error,
          "Unable to reach the backend. Start the API server and check the configured port."
        );
        setAppError(message);
        setInspectorError(message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!appNotice) {
      return;
    }
    const timeoutId = window.setTimeout(() => setAppNotice(null), 4500);
    return () => window.clearTimeout(timeoutId);
  }, [appNotice]);

  useEffect(() => {
    if (!currentRunId) {
      return;
    }
    const activeStatuses = new Set(["queued", "in_progress", "cancel_requested"]);
    if (!activeStatuses.has(currentRun?.status ?? "")) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        try {
          const [details, eventResponse, fileResponse] = await Promise.all([
            getRun(currentRunId),
            getRunEvents(currentRunId, eventsRef.current.at(-1)?.seq ?? 0),
            getRunFiles(currentRunId)
          ]);
          setCurrentRun(details);
          upsertRun(details);
          setAgents(details.agents ?? []);
          setTasks(details.tasks ?? []);
          setRunFiles(fileResponse.files);
          if (eventResponse.events.length) {
            for (const event of eventResponse.events) {
              appendEvent(event);
            }
          }
          if (selectedAgentId) {
            const history = await getAgentHistory(currentRunId, selectedAgentId);
            setSelectedAgentHistory(history.messages);
          }
        } catch (error) {
          setAppError(toErrorMessage(error, "Unable to refresh the active run."));
        }
      })();
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [currentRun?.status, currentRunId, selectedAgentId]);

  const value: AppStore = {
    runs,
    currentRunId,
    currentRun,
    agents,
    tasks,
    events,
    selectedAgentId,
    selectedAgentHistory,
    isStreaming,
    ragModeEnabled,
    ragModeBusy,
    appError,
    appNotice,
    inspectorError,
    skills,
    editableFiles,
    runFiles,
    inspectorPath,
    inspectorContent,
    inspectorDirty,
    sidebarWidth,
    inspectorWidth,
    submitPrompt,
    startRun: launchNewRun,
    startNewRun: launchNewRun,
    prepareNewRun,
    selectRun,
    cancelCurrentRun,
    resumeCurrentRun,
    clearAllRuns,
    clearAllSessions,
    toggleRagMode,
    selectAgent,
    loadInspectorFile,
    updateInspectorContent,
    saveInspector,
    refreshCurrentRun,
    setSidebarWidth,
    setInspectorWidth
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useAppStore() {
  const value = useContext(StoreContext);
  if (!value) {
    throw new Error("useAppStore must be used inside AppProvider");
  }
  return value;
}
