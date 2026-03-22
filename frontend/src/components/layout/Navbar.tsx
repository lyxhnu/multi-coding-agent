"use client";

import {
  Activity,
  Brain,
  FilePlus2,
  FileStack,
  Play,
  Sparkles,
  Square,
  Trash2
} from "lucide-react";

import { useAppStore } from "@/lib/store";

export function Navbar() {
  const {
    currentRun,
    agents,
    tasks,
    appError,
    appNotice,
    isStreaming,
    ragModeBusy,
    ragModeEnabled,
    prepareNewRun,
    refreshCurrentRun,
    cancelCurrentRun,
    resumeCurrentRun,
    clearAllRuns,
    clearAllSessions,
    toggleRagMode
  } = useAppStore();

  const completedTasks = tasks.filter((task) => task.status === "completed").length;

  return (
    <header className="panel rounded-[30px] px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(15,139,141,0.14)] text-ocean">
            <Sparkles size={20} />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-[var(--color-ink-soft)]">
              multi-coding agent
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold tracking-[-0.04em]">
                {currentRun?.run_id ?? "No active run"}
              </h1>
              <span className="rounded-full border border-[var(--color-line)] px-3 py-1 text-xs uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
                {currentRun ? `${currentRun.status} / ${currentRun.phase}` : "idle"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/60 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            disabled={ragModeBusy}
            onClick={() => void toggleRagMode()}
            type="button"
          >
            <Brain size={16} />
            {ragModeBusy ? "Updating RAG..." : ragModeEnabled ? "RAG On" : "RAG Off"}
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/60 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isStreaming}
            onClick={prepareNewRun}
            type="button"
          >
            <FilePlus2 size={16} />
            New Session
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/60 px-4 py-2 text-sm"
            onClick={() => void refreshCurrentRun()}
            type="button"
          >
            <Activity size={16} />
            Refresh
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/60 px-4 py-2 text-sm"
            onClick={() => void resumeCurrentRun()}
            type="button"
          >
            <Play size={16} />
            Resume
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[rgba(212,106,74,0.24)] bg-[rgba(212,106,74,0.12)] px-4 py-2 text-sm text-[var(--color-ember)]"
            onClick={() => void cancelCurrentRun()}
            type="button"
          >
            <Square size={16} />
            Cancel
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/60 px-4 py-2 text-sm"
            onClick={() => void clearAllSessions()}
            type="button"
          >
            <Trash2 size={16} />
            Clear Sessions
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[rgba(212,106,74,0.24)] bg-[rgba(212,106,74,0.08)] px-4 py-2 text-sm text-[var(--color-ember)]"
            onClick={() => void clearAllRuns()}
            type="button"
          >
            <Trash2 size={16} />
            Clear Runs
          </button>
          <div className="hidden items-center gap-2 rounded-full bg-[rgba(15,139,141,0.12)] px-4 py-2 text-sm text-ocean md:flex">
            <FileStack size={16} />
            {agents.length} agents / {completedTasks} of {tasks.length} tasks done
          </div>
        </div>
      </div>

      {appError && (
        <div className="mt-4 rounded-[22px] border border-[rgba(212,106,74,0.26)] bg-[rgba(212,106,74,0.12)] px-4 py-3 text-sm text-[var(--color-ember)]">
          {appError}
        </div>
      )}
      {!appError && appNotice && (
        <div className="mt-4 rounded-[22px] border border-[rgba(15,139,141,0.24)] bg-[rgba(15,139,141,0.12)] px-4 py-3 text-sm text-ocean">
          {appNotice}
        </div>
      )}
    </header>
  );
}
