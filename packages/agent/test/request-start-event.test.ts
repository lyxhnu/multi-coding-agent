import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "trace-model",
		name: "Trace model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "trace-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("request_start event", () => {
	it("emits the exact transformed request before auth resolution and dispatch", async () => {
		const prompt: AgentMessage = { role: "user", content: "original", timestamp: 1 };
		const transformed: AgentMessage = { role: "user", content: "transformed", timestamp: 2 };
		const context: AgentContext = { systemPrompt: "system", messages: [], tools: [] };
		const events: AgentEvent[] = [];
		let requestSeen = false;
		let dispatchedContext: Parameters<NonNullable<Parameters<typeof runAgentLoop>[5]>>[1] | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			reasoning: "high",
			transformContext: async () => [transformed],
			convertToLlm: (messages) =>
				messages.filter(
					(message): message is Message =>
						message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				),
			getApiKey: () => {
				expect(requestSeen).toBe(true);
				return "key";
			},
		};
		const streamFunction: Parameters<typeof runAgentLoop>[5] = (_model, requestContext) => {
			dispatchedContext = requestContext;
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Unexpected event");
				},
			);
			queueMicrotask(() => {
				const message = createAssistantMessage();
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		await runAgentLoop(
			[prompt],
			context,
			config,
			(event) => {
				events.push(event);
				if (event.type === "request_start") requestSeen = true;
			},
			undefined,
			streamFunction,
		);

		const requestEvent = events.find(
			(event): event is Extract<AgentEvent, { type: "request_start" }> => event.type === "request_start",
		);
		expect(requestEvent).toEqual({
			type: "request_start",
			model: config.model,
			context: { systemPrompt: "system", messages: [transformed], tools: [] },
			reasoning: "high",
		});
		expect(dispatchedContext).toBe(requestEvent?.context);
	});
});
