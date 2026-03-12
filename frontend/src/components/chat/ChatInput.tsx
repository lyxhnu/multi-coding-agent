"use client";

import { Play, SquareTerminal } from "lucide-react";
import { useState } from "react";

export function ChatInput({
  disabled,
  onSend
}: {
  disabled: boolean;
  onSend: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");

  return (
    <div className="panel rounded-[28px] p-3">
      <textarea
        className="min-h-28 w-full resize-none rounded-[22px] border border-[var(--color-line)] bg-white/70 px-4 py-3 outline-none"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            const nextValue = value.trim();
            if (!nextValue) {
              return;
            }
            void onSend(nextValue);
            setValue("");
          }
        }}
        placeholder="Describe the coding task for the multi-agent team. Ctrl/Cmd + Enter to launch."
        value={value}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
          <SquareTerminal size={16} />
          PC / CA / FD / BD / DE / QT will coordinate through runs, tasks, events, and files.
        </div>
        <button
          className="flex items-center gap-2 rounded-full bg-ocean px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-[rgba(15,139,141,0.45)]"
          disabled={disabled || !value.trim()}
          onClick={() => {
            const nextValue = value.trim();
            if (!nextValue) {
              return;
            }
            void onSend(nextValue);
            setValue("");
          }}
          type="button"
        >
          <Play size={16} />
          Launch Run
        </button>
      </div>
    </div>
  );
}
