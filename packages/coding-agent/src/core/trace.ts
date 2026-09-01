import type { AgentEvent, AgentRunOutcome } from "@earendil-works/pi-agent-core";
import type { ContextBudget } from "@earendil-works/pi-ai";
import type {
	AssistantMessageEvent,
	Message,
	StopReason,
	ThinkingLevel,
	Tool,
	Usage,
} from "@earendil-works/pi-ai/compat";
import type { TaskKind, TaskStatus } from "./tasks/types.ts";

export type TraceRequestTool = Pick<Tool, "name" | "description" | "parameters" | "constrainedSampling">;

/** Exact, serializable request state at the low-level provider boundary. */
export interface TraceRequestHeader {
	provider: string;
	model: string;
	reasoning?: ThinkingLevel;
	systemPrompt?: string;
	messages: Message[];
	tools?: TraceRequestTool[];
}

/** Compact stream event. The cumulative `partial` message is intentionally omitted. */
export type TraceAssistantChunk =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>;
	  }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse"> }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; errorMessage?: string };

/** Log-only trace vocabulary stored beside the normal session entries. */
export type SessionTraceEvent =
	| { type: "turn/start"; data: { turn: number } }
	| {
			type: "turn/end";
			data: {
				turn: number;
				stopReason?: StopReason;
				errorMessage?: string;
				willRetry: boolean;
				outcome?: AgentRunOutcome;
			};
	  }
	| { type: "step/start"; data: { turn: number; step: number } }
	| {
			type: "step/end";
			data: { turn: number; step: number; stopReason?: StopReason; usage?: Usage };
	  }
	| { type: "request/header"; data: { turn: number; step: number; header: TraceRequestHeader } }
	| { type: "context/budget"; data: { turn: number; step: number; budget: ContextBudget } }
	| {
			type: "compaction/summary";
			data: {
				turn: number;
				phase: "prefix" | "commit";
				outcome: "completed" | "discarded";
				compactionId?: string;
				sourceFingerprint: string;
				firstKeptEntryId: string;
				coveredStartEntryId?: string;
				coveredEndEntryId?: string;
				usage?: Usage;
			};
	  }
	| {
			type: "memory/archive";
			data: {
				turn: number;
				compactionId: string;
				ran: boolean;
				reason: string;
				written?: number;
				skipped?: number;
				reasons?: string[];
				usage?: Usage;
				batchId?: string;
				sourceNoteIds?: string[];
			};
	  }
	| { type: "assistant/chunk"; data: { turn: number; step: number; chunk: TraceAssistantChunk } }
	| {
			type: "tool/call";
			data: { turn: number; step: number; callId: string; name: string; arguments: unknown };
	  }
	| {
			type: "tool/result";
			data: { turn: number; step: number; callId: string; name: string; isError: boolean };
	  }
	| {
			type: "task/state";
			data: {
				turn: number;
				taskId: string;
				kind: TaskKind;
				from?: TaskStatus;
				to: TaskStatus;
				reason?: string;
			};
	  };

export function createTraceRequestHeader(event: Extract<AgentEvent, { type: "request_start" }>): TraceRequestHeader {
	const tools = event.context.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: structuredClone(tool.parameters),
		...(tool.constrainedSampling === undefined
			? {}
			: { constrainedSampling: structuredClone(tool.constrainedSampling) }),
	}));
	return {
		provider: event.model.provider,
		model: event.model.id,
		...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }),
		...(event.context.systemPrompt === undefined ? {} : { systemPrompt: event.context.systemPrompt }),
		messages: structuredClone(event.context.messages),
		...(tools === undefined || tools.length === 0 ? {} : { tools }),
	};
}

export function createTraceAssistantChunk(event: AssistantMessageEvent): TraceAssistantChunk {
	switch (event.type) {
		case "start":
			return { type: "start" };
		case "text_start":
			return { type: event.type, contentIndex: event.contentIndex };
		case "text_delta":
			return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
			return { type: event.type, contentIndex: event.contentIndex, content: event.content };
		case "thinking_start":
			return { type: event.type, contentIndex: event.contentIndex };
		case "thinking_delta":
			return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end":
			return { type: event.type, contentIndex: event.contentIndex, content: event.content };
		case "toolcall_start":
			return { type: event.type, contentIndex: event.contentIndex };
		case "toolcall_delta":
			return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end":
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				toolCall: structuredClone(event.toolCall),
			};
		case "done":
			return { type: event.type, reason: event.reason };
		case "error":
			return {
				type: event.type,
				reason: event.reason,
				...(event.error.errorMessage === undefined ? {} : { errorMessage: event.error.errorMessage }),
			};
	}
}

export function getNextTraceTurn(entries: readonly { type: string; event?: SessionTraceEvent }[]): number {
	let nextTurn = 0;
	for (const entry of entries) {
		if (entry.type === "trace" && entry.event?.type === "turn/start") {
			nextTurn = Math.max(nextTurn, entry.event.data.turn + 1);
		}
	}
	return nextTurn;
}
