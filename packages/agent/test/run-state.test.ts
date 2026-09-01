import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type AgentRunState, reduceAgentRunState } from "../src/index.ts";

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 1,
};

describe("reduceAgentRunState", () => {
	it("reduces a complete request and tool lifecycle", () => {
		let state: AgentRunState = { status: "running", runId: 1, turn: 0, phase: { type: "preparing" } };
		state = reduceAgentRunState(state, { type: "agent_start" });
		state = reduceAgentRunState(state, { type: "turn_start" });
		state = reduceAgentRunState(state, {
			type: "request_start",
			model: {
				id: "mock",
				name: "mock",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1,
				maxTokens: 1,
			},
			context: { systemPrompt: "", messages: [] },
			reasoning: undefined,
		});
		state = reduceAgentRunState(state, { type: "message_start", message: assistantMessage });
		state = reduceAgentRunState(state, { type: "message_end", message: assistantMessage });
		state = reduceAgentRunState(state, {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: {},
		});
		expect(
			state.status === "running" && state.phase.type === "executing_tools"
				? [...state.phase.pendingToolCallIds]
				: [],
		).toEqual(["call-1"]);
		state = reduceAgentRunState(state, {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: {},
			isError: false,
		});
		state = reduceAgentRunState(state, { type: "turn_end", message: assistantMessage, toolResults: [] });
		state = reduceAgentRunState(state, { type: "agent_end", messages: [assistantMessage] });
		expect(state).toMatchObject({
			status: "running",
			turn: 1,
			phase: { type: "settling", outcome: { type: "completed" } },
		});
	});

	it("rejects events while idle and illegal phase transitions", () => {
		expect(() => reduceAgentRunState({ status: "idle" }, { type: "agent_start" })).toThrow("agent_start while idle");
		expect(() =>
			reduceAgentRunState(
				{ status: "running", runId: 1, turn: 1, phase: { type: "streaming", message: assistantMessage } },
				{ type: "turn_start" },
			),
		).toThrow("turn_start from streaming");
	});
});
