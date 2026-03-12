"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { RunEvent } from "@/lib/api";

type TimelineEvent = RunEvent & {
  seq_end?: number;
  chunk_count?: number;
};

function labelForEvent(event: RunEvent) {
  const role = event.role ? `${event.role} ` : "";
  switch (event.type) {
    case "agent_dispatch":
      return `${role}dispatch`;
    case "agent_status":
      return `${role}status`;
    case "tool_start":
      return `${role}${event.tool ?? "tool"} start`;
    case "tool_end":
      return `${role}${event.tool ?? "tool"} end`;
    case "task_update":
      return `${role}task`;
    case "retrieval":
      return `${role}retrieval`;
    case "token":
      return `${role}stream`;
    case "file_write":
      return `${role}file write`;
    case "message_acked":
      return `${role}message ack`;
    case "task_timeout":
      return `${role}timeout`;
    default:
      return event.type;
  }
}

export function EventCard({ event }: { event: TimelineEvent }) {
  const isToken = event.type === "token";
  const isError = event.type === "error" || event.error;
  const seqLabel =
    event.seq_end && event.seq_end > event.seq ? `#${event.seq}-${event.seq_end}` : `#${event.seq}`;

  return (
    <article
      className={`rounded-[26px] border px-4 py-4 ${
        isError
          ? "border-[rgba(212,106,74,0.28)] bg-[rgba(212,106,74,0.12)]"
          : isToken
            ? "border-[rgba(15,139,141,0.14)] bg-[rgba(15,139,141,0.08)]"
            : "border-[var(--color-line)] bg-white/60"
      }`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.22em] text-[var(--color-ink-soft)]">
        <span>{labelForEvent(event)}</span>
        <span>{seqLabel}</span>
        {event.role && <span>{event.role}</span>}
        {event.task_id && <span>{event.task_id}</span>}
        {event.status && <span>{event.status}</span>}
        {isToken && event.chunk_count && event.chunk_count > 1 && <span>{event.chunk_count} chunks</span>}
      </div>

      {event.title && <h3 className="text-base font-semibold">{event.title}</h3>}

      {event.path ? (
        <div className="mt-2 rounded-2xl bg-[rgba(13,37,48,0.06)] px-3 py-2 text-sm">
          <span className="font-medium">Path:</span> {String(event.path)}
        </div>
      ) : null}

      {event.summary && (
        <div className="markdown mt-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(event.summary)}</ReactMarkdown>
        </div>
      )}

      {event.content && (
        <div className={`mt-3 ${isToken ? "text-sm leading-7" : "markdown"}`}>
          {isToken ? (
            <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap rounded-2xl bg-white/60 p-3">
              {event.content}
            </pre>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(event.content)}</ReactMarkdown>
          )}
        </div>
      )}

      {event.results?.length ? (
        <div className="mt-3 rounded-2xl bg-[rgba(13,37,48,0.06)] p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
            Retrieval
          </div>
          <div className="space-y-2 text-sm">
            {event.results.map((result, index) => (
              <div className="rounded-2xl bg-white/60 p-3" key={`${result.source}-${index}`}>
                <div className="mb-1 font-medium">{result.source}</div>
                <div className="text-[var(--color-ink-soft)]">{result.text}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {event.input && (
        <div className="mt-3 rounded-2xl bg-[rgba(13,37,48,0.06)] p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
            Input
          </div>
          <pre className="mono whitespace-pre-wrap text-xs">{event.input}</pre>
        </div>
      )}

      {event.output && (
        <div className="mt-3 rounded-2xl bg-[rgba(13,37,48,0.06)] p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
            Output
          </div>
          <pre className="mono whitespace-pre-wrap text-xs">{event.output}</pre>
        </div>
      )}

      {event.error && (
        <div className="mt-3 rounded-2xl bg-white/70 p-3 text-sm text-[var(--color-ember)]">
          {String(event.error)}
        </div>
      )}
    </article>
  );
}
