"use client";

import { Bot, ClipboardList, Layers3, PlayCircle } from "lucide-react";

import { useAppStore } from "@/lib/store";

function preview(text: string) {
  return text.length > 68 ? `${text.slice(0, 68)}...` : text;
}

export function Sidebar() {
  const {
    runs,
    currentRunId,
    agents,
    tasks,
    selectedAgentId,
    selectRun,
    selectAgent
  } = useAppStore();

  return (
    <aside className="panel flex h-full flex-col rounded-[30px] p-4">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-ink-soft)]">
          Runs
        </p>
        <h2 className="text-lg font-semibold tracking-[-0.04em]">Dispatch board</h2>
      </div>

      <div className="space-y-2 overflow-y-auto pr-1">
        {runs.map((run) => (
          <button
            className={`w-full rounded-3xl border px-4 py-3 text-left transition ${
              run.run_id === currentRunId
                ? "border-transparent bg-[rgba(15,139,141,0.16)]"
                : "border-[var(--color-line)] bg-white/45"
            }`}
            key={run.run_id}
            onClick={() => void selectRun(run.run_id)}
            type="button"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{run.run_id}</p>
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{preview(run.request)}</p>
              </div>
              <PlayCircle className="mt-1 text-[var(--color-ink-soft)]" size={16} />
            </div>
            <div className="mt-3 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
              <span>{run.status}</span>
              <span>{run.phase}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-[24px] border border-[var(--color-line)] bg-white/40 p-3">
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-[var(--color-ink-soft)]">
          <Bot size={14} />
          Agents
        </div>
        <div className="space-y-2">
          {agents.map((agent) => (
            <button
              className={`w-full rounded-2xl border px-3 py-2 text-left ${
                agent.agent_id === selectedAgentId
                  ? "border-transparent bg-[rgba(13,37,48,0.9)] text-white"
                  : "border-[var(--color-line)] bg-white/70"
              }`}
              key={agent.agent_id}
              onClick={() => void selectAgent(agent.agent_id)}
              type="button"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{agent.role}</span>
                <span className="text-[10px] uppercase tracking-[0.18em]">{agent.status}</span>
              </div>
              <div className="mt-1 text-xs opacity-80">{agent.current_task_id || "idle"}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-[24px] border border-[var(--color-line)] bg-white/40 p-3">
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-[var(--color-ink-soft)]">
          <ClipboardList size={14} />
          Task Board
        </div>
        <div className="space-y-3 overflow-y-auto pr-1">
          {tasks.map((task) => (
            <div
              className="rounded-2xl border border-[var(--color-line)] bg-white/70 px-3 py-3"
              key={task.task_id}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers3 size={14} />
                  <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
                    {task.owner_role}
                  </span>
                </div>
                <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-ink-soft)]">
                  {task.status}
                </span>
              </div>
              <p className="font-medium">{task.title}</p>
              <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                {task.progress}% complete
              </p>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
