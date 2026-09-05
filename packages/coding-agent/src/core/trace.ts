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
import type {
	BudgetVerification,
	ContextMaintenanceAction,
	ContextMaintenanceCause,
	ContextMaintenancePhase,
	ContextMaintenanceReasonCode,
	ContextMaintenanceState,
	ContinuationIntent,
	ReductionMethod,
} from "./compaction/context-maintenance.ts";
import type { ContextRolloverBlockedReason } from "./context-rollover.ts";
import type { TaskNoteKind } from "./task-note-projection.ts";
import type { TaskKind, TaskStatus } from "./tasks/types.ts";

export type TraceRequestTool = Pick<Tool, "name">;

/** Exact, serializable request state at the low-level provider boundary. */
export interface TraceRequestHeader {
	provider: string;
	model: string;
	reasoning?: ThinkingLevel;
	/** Message roles only; request正文 is intentionally excluded from the trace. */
	messages: Array<Pick<Message, "role">>;
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
	| { type: "toolcall_delta"; contentIndex: number }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: { id: string; name: string };
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
			type: "context/maintenance";
			data: {
				maintenanceId: string;
				triggerId?: string;
				turn: number;
				promptGeneration: number;
				cause: ContextMaintenanceCause;
				phase: ContextMaintenancePhase;
				state: ContextMaintenanceState;
				method?: ReductionMethod;
				attemptIndex?: number;
				requestFingerprint: string;
				outcome:
					| "entered"
					| "committed"
					| "unavailable"
					| "failed"
					| "superseded"
					| "vetoed"
					| "ready"
					| "blocked"
					| "cancelled"
					| "dispatched";
				tokensBefore?: number;
				tokensAfter?: number;
				budgetDecision?: ContextBudget["decision"];
				verification?: BudgetVerification | "not_required";
				continuation?: ContinuationIntent;
				nextAction?: ContextMaintenanceAction;
				dispatchStatus?: "executed" | "coalesced";
				reasonCode?: ContextMaintenanceReasonCode;
			};
	  }
	| {
			type: "context/rollover";
			data: {
				rolloverId: string;
				checkpointId?: string;
				dispatchId?: string;
				turn: number;
				promptGeneration: number;
				sourceContextEpoch: number;
				targetContextEpoch?: number;
				phase: "checkpoint" | "rollover" | "preparation" | "dispatch";
				outcome:
					| "entered"
					| "waiting"
					| "committed"
					| "discarded"
					| "prepared"
					| "started"
					| "finished"
					| "blocked"
					| "cancelled"
					| "outcome_unknown";
				sourceRequestFingerprint?: string;
				preparedRequestFingerprint?: string;
				sourceTokens?: number;
				preparedTokens?: number;
				reservedDeliveryCount?: number;
				strongProgressCreditCount?: number;
				reasonCode?: ContextRolloverBlockedReason;
			};
	  }
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
			data: { turn: number; step: number; callId: string; name: string };
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
	  }
	| {
			type: "context/task_note";
			data: {
				turn: number;
				eventId?: string;
				batchId?: string;
				promptGeneration: number;
				contextEpoch: number;
				kind?: TaskNoteKind;
				key?: string;
				operation?: "upsert" | "retract" | "project";
				outcome: "accepted" | "rejected" | "rebuilt";
				activeCount?: number;
				staleCount?: number;
				reasonCode?: string;
			};
	  };

export function createTraceRequestHeader(event: Extract<AgentEvent, { type: "request_start" }>): TraceRequestHeader {
	const tools = event.context.tools?.map((tool) => ({ name: tool.name }));
	return {
		provider: event.model.provider,
		model: event.model.id,
		...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }),
		messages: event.context.messages.map((message) => ({ role: message.role })),
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
			return { type: event.type, contentIndex: event.contentIndex };
		case "toolcall_end":
			return {
				type: event.type,
				contentIndex: event.contentIndex,
				toolCall: { id: event.toolCall.id, name: event.toolCall.name },
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
