"use client";

import { Play, SquareTerminal } from "lucide-react";
import { useState } from "react";

export function ChatInput({
  disabled,
  hasActiveRun,
  onPrepareNewRun,
  onNewRun,
  onSend
}: {
  disabled: boolean;
  hasActiveRun: boolean;
  onPrepareNewRun: () => void;
  onNewRun: (value: string) => Promise<void>;
  onSend: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");

  async function submit(mode: "continue" | "new") {
    const nextValue = value.trim();
    if (!nextValue || disabled) {
      return;
    }

    try {
      if (mode === "new") {
        await onNewRun(nextValue);
      } else {
        await onSend(nextValue);
      }
      setValue("");
    } catch {
      // Keep the draft so the user can retry after transient backend errors.
    }
  }

  return (
    <div className="panel rounded-[28px] p-3">
      <textarea
        className="min-h-28 w-full resize-none rounded-[22px] border border-[var(--color-line)] bg-white/70 px-4 py-3 outline-none"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit("continue");
          }
        }}
        placeholder={
          hasActiveRun
            ? "Continue the current run with a follow-up request. Ctrl/Cmd + Enter to keep working in this run."
            : "Describe the coding task for the multi-agent team. Ctrl/Cmd + Enter to launch a new run."
        }
        value={value}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
          <SquareTerminal size={16} />
          {hasActiveRun
            ? "Continue the selected run by default. Use New Run only when you want a fresh project context."
            : "PC / CA / FD / BD / DE / QT will coordinate through runs, tasks, events, and files."}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/70 px-4 py-2 text-sm text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled}
            onClick={onPrepareNewRun}
            type="button"
          >
            <SquareTerminal size={16} />
            New Session
          </button>
          <button
            className="flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-white/70 px-4 py-2 text-sm text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled || !value.trim()}
            onClick={() => void submit("new")}
            type="button"
          >
            <Play size={16} />
            New Run
          </button>
          <button
            className="flex items-center gap-2 rounded-full bg-ocean px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-[rgba(15,139,141,0.45)]"
            disabled={disabled || !value.trim()}
            onClick={() => void submit("continue")}
            type="button"
          >
            <Play size={16} />
            {hasActiveRun ? "Continue Run" : "Launch Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
