import type { AgentEvent, AgentRunOutcome, AgentRunState } from "./types.ts";

function outcomeFromAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): AgentRunOutcome {
	if (event.outcome) return event.outcome;
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const message = event.messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return { type: "aborted", message: message.errorMessage };
		if (message.stopReason === "error") {
			return { type: "failed", message: message.errorMessage ?? "Agent run failed" };
		}
		break;
	}
	return { type: "completed" };
}

function requireRunning(state: AgentRunState, event: AgentEvent): Extract<AgentRunState, { status: "running" }> {
	if (state.status === "idle") throw new Error(`Invalid agent state transition: ${event.type} while idle`);
	return state;
}

/** Reduces one runtime event into the next explicit agent run state. */
export function reduceAgentRunState(state: AgentRunState, event: AgentEvent): AgentRunState {
	const running = requireRunning(state, event);
	if (running.phase.type === "cancelling" && event.type !== "agent_end") return running;

	switch (event.type) {
		case "queue_delivery":
			return running;
		case "context_budget":
			if (running.phase.type !== "preparing") throw new Error("Context preflight outside preparing phase");
			return running;
		case "agent_start":
			if (running.phase.type !== "preparing" || running.turn !== 0) {
				throw new Error(`Invalid agent state transition: agent_start from ${running.phase.type}`);
			}
			return running;
		case "turn_start":
			if (
				running.phase.type !== "preparing" &&
				running.phase.type !== "between_turns" &&
				running.phase.type !== "processing_response"
			) {
				throw new Error(`Invalid agent state transition: turn_start from ${running.phase.type}`);
			}
			return { ...running, turn: running.turn + 1, phase: { type: "preparing" } };
		case "request_start":
			if (running.phase.type !== "preparing") {
				throw new Error(`Invalid agent state transition: request_start from ${running.phase.type}`);
			}
			return { ...running, phase: { type: "requesting" } };
		case "message_start":
			if (event.message.role !== "assistant") return running;
			if (
				running.phase.type !== "requesting" &&
				(event.message.stopReason !== "error" || running.phase.type === "settling") &&
				(event.message.stopReason !== "aborted" || running.phase.type === "settling")
			) {
				throw new Error(`Invalid agent state transition: assistant message_start from ${running.phase.type}`);
			}
			return { ...running, phase: { type: "streaming", message: event.message } };
		case "message_update":
			if (running.phase.type !== "streaming") {
				throw new Error(`Invalid agent state transition: message_update from ${running.phase.type}`);
			}
			return { ...running, phase: { type: "streaming", message: event.message } };
		case "message_end":
			if (event.message.role !== "assistant") return running;
			if (running.phase.type !== "streaming") {
				throw new Error(`Invalid agent state transition: assistant message_end from ${running.phase.type}`);
			}
			return { ...running, phase: { type: "processing_response" } };
		case "tool_execution_start": {
			if (running.phase.type !== "processing_response" && running.phase.type !== "executing_tools") {
				throw new Error(`Invalid agent state transition: tool_execution_start from ${running.phase.type}`);
			}
			const pendingToolCallIds = new Set(
				running.phase.type === "executing_tools" ? running.phase.pendingToolCallIds : [],
			);
			pendingToolCallIds.add(event.toolCallId);
			return { ...running, phase: { type: "executing_tools", pendingToolCallIds } };
		}
		case "tool_execution_update":
			if (running.phase.type !== "executing_tools" || !running.phase.pendingToolCallIds.has(event.toolCallId)) {
				throw new Error(`Invalid agent state transition: tool_execution_update for ${event.toolCallId}`);
			}
			return running;
		case "tool_execution_end": {
			if (running.phase.type !== "executing_tools" || !running.phase.pendingToolCallIds.has(event.toolCallId)) {
				throw new Error(`Invalid agent state transition: tool_execution_end for ${event.toolCallId}`);
			}
			const pendingToolCallIds = new Set(running.phase.pendingToolCallIds);
			pendingToolCallIds.delete(event.toolCallId);
			return pendingToolCallIds.size === 0
				? { ...running, phase: { type: "processing_response" } }
				: { ...running, phase: { type: "executing_tools", pendingToolCallIds } };
		}
		case "turn_end":
			if (running.phase.type !== "processing_response") {
				throw new Error(`Invalid agent state transition: turn_end from ${running.phase.type}`);
			}
			return { ...running, phase: { type: "between_turns" } };
		case "agent_end": {
			if (running.phase.type === "settling") throw new Error("Invalid agent state transition: duplicate agent_end");
			const outcome = outcomeFromAgentEnd(event);
			return {
				...running,
				phase: {
					type: "settling",
					outcome:
						running.phase.type === "cancelling" && outcome.type !== "aborted" ? { type: "aborted" } : outcome,
				},
			};
		}
	}
}
