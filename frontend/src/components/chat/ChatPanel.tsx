"use client";

import { useEffect, useMemo, useRef } from "react";

import { ChatInput } from "@/components/chat/ChatInput";
import { EventCard } from "@/components/chat/EventCard";
import type { RunEvent } from "@/lib/api";
import { useAppStore } from "@/lib/store";

type TimelineEvent = RunEvent & {
  seq_end?: number;
  chunk_count?: number;
};

function canMergeStreamEvent(previous: TimelineEvent | undefined, next: RunEvent) {
  return (
    previous?.type === "token" &&
    next.type === "token" &&
    previous.run_id === next.run_id &&
    previous.agent_id === next.agent_id &&
    previous.task_id === next.task_id
  );
}

function compactTimeline(events: RunEvent[]): TimelineEvent[] {
  const compacted: TimelineEvent[] = [];

  for (const event of events) {
    const previous = compacted.at(-1);
    if (previous && canMergeStreamEvent(previous, event)) {
      previous.content = `${String(previous.content ?? "")}${String(event.content ?? "")}`;
      previous.seq_end = event.seq;
      previous.chunk_count = (previous.chunk_count ?? 1) + 1;
      previous.timestamp = event.timestamp;
      continue;
    }

    compacted.push({
      ...event,
      seq_end: event.seq,
      chunk_count: event.type === "token" ? 1 : undefined
    });
  }

  return compacted;
}

export function ChatPanel() {
  const { currentRun, events, selectedAgentId, selectedAgentHistory, startRun, isStreaming } =
    useAppStore();
  const endRef = useRef<HTMLDivElement | null>(null);
  const timelineEvents = useMemo(() => compactTimeline(events), [events]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timelineEvents]);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col gap-4">
      <div className="panel flex items-center justify-between rounded-[30px] px-5 py-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-ink-soft)]">
            Run Timeline
          </p>
          <h2 className="text-lg font-semibold tracking-[-0.04em]">
            White-box multi-agent orchestration
          </h2>
        </div>
        <div className="mono text-sm text-[var(--color-ink-soft)]">
          {currentRun ? `${currentRun.status} / ${currentRun.phase}` : "No active run"}
        </div>
      </div>

      <div className="panel flex min-h-0 flex-1 flex-col rounded-[32px] p-5">
        <div className="flex-1 space-y-4 overflow-y-auto pr-2">
          {!events.length && (
            <div className="rounded-[28px] border border-dashed border-[var(--color-line)] bg-white/45 p-8">
              <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-ink-soft)]">
                Ready
              </p>
              <h3 className="mt-2 text-3xl font-semibold tracking-[-0.05em]">
                Turn the workspace into a real multi-agent coding system
              </h3>
              <p className="mt-3 max-w-2xl text-[var(--color-ink-soft)]">
                Start a run to watch agent dispatch, tool calls, file updates, retries, and final
                delivery unfold in the timeline.
              </p>
            </div>
          )}

          {timelineEvents.map((event) => (
            <EventCard event={event} key={event.event_id} />
          ))}

          {selectedAgentId && selectedAgentHistory.length ? (
            <div className="rounded-[28px] border border-[var(--color-line)] bg-white/50 p-5">
              <div className="mb-3 text-xs uppercase tracking-[0.24em] text-[var(--color-ink-soft)]">
                Selected Agent History
              </div>
              <div className="space-y-3">
                {selectedAgentHistory.map((entry) => (
                  <div className="rounded-2xl bg-white/70 p-3" key={entry.id}>
                    <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
                      <span>{entry.role}</span>
                      <span>{entry.timestamp}</span>
                    </div>
                    <pre className="mono whitespace-pre-wrap text-sm">{entry.content}</pre>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>

      <ChatInput disabled={isStreaming} onSend={startRun} />
    </section>
  );
}
