import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, createProviderRequestFingerprint } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => this.push({ type: "done", reason: "stop", message }));
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "prepared-test",
		name: "prepared-test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "prepared-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("PreparedContinuation", () => {
	it("PC01/PC08/PC09 prepares the exact first provider request once", async () => {
		const model = createModel();
		let transformCalls = 0;
		let convertCalls = 0;
		let providerCalls = 0;
		let actualRequestFingerprint: string | undefined;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "system",
				messages: [{ role: "user", content: "continue", timestamp: 1 }],
			},
			transformContext: async (messages) => {
				transformCalls++;
				return messages.slice();
			},
			convertToLlm: (messages) => {
				convertCalls++;
				return messages.filter(
					(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				);
			},
			streamFn: () => {
				providerCalls++;
				return new MockAssistantStream(createAssistantMessage());
			},
		});
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "request_start") {
				actualRequestFingerprint = createProviderRequestFingerprint(event.context, event.model, {
					reasoning: event.reasoning,
				});
			}
		});

		const preparation = await agent.prepareContinuation(agent.state.messages);

		expect(transformCalls).toBe(1);
		expect(convertCalls).toBe(1);
		expect(providerCalls).toBe(0);

		await agent.dispatchPreparedContinuation(preparation);

		expect(providerCalls).toBe(1);
		expect(transformCalls).toBe(1);
		expect(convertCalls).toBe(1);
		expect(actualRequestFingerprint).toBe(preparation.requestFingerprint);
	});

	it("PC02/PC11 reserves steering and release restores its queue position", async () => {
		const agent = new Agent({
			initialState: {
				model: createModel(),
				messages: [{ role: "user", content: "start", timestamp: 1 }, createAssistantMessage()],
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage()),
		});
		agent.steer({
			queueItemId: "steer-1",
			message: { role: "user", content: "first", timestamp: 2 },
		});
		agent.steer({
			queueItemId: "steer-2",
			message: { role: "user", content: "second", timestamp: 3 },
		});

		const first = await agent.prepareContinuation(agent.state.messages);
		expect(first.reservedQueueItemIds).toEqual(["steer-1"]);
		agent.releasePreparedContinuation(first);

		const second = await agent.prepareContinuation(agent.state.messages);
		expect(second.reservedQueueItemIds).toEqual(["steer-1"]);
	});

	it("PC14 routes ordinary continue through one prepared request", async () => {
		let transformCalls = 0;
		let convertCalls = 0;
		const agent = new Agent({
			initialState: {
				model: createModel(),
				messages: [{ role: "user", content: "continue", timestamp: 1 }],
			},
			transformContext: async (messages) => {
				transformCalls++;
				return messages;
			},
			convertToLlm: (messages) => {
				convertCalls++;
				return messages.filter(
					(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				);
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage()),
		});

		await agent.continue();

		expect(transformCalls).toBe(1);
		expect(convertCalls).toBe(1);
	});

	it("PC12 shares one preparation for concurrent matching callers", async () => {
		let releaseTransform = () => {};
		const transformBarrier = new Promise<void>((resolve) => {
			releaseTransform = resolve;
		});
		let transformCalls = 0;
		const messages = [{ role: "user" as const, content: "continue", timestamp: 1 }];
		const agent = new Agent({
			initialState: { model: createModel(), messages },
			transformContext: async (currentMessages) => {
				transformCalls++;
				await transformBarrier;
				return currentMessages;
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage()),
		});

		const firstPromise = agent.prepareContinuation(messages);
		const secondPromise = agent.prepareContinuation(messages);
		releaseTransform();
		const [first, second] = await Promise.all([firstPromise, secondPromise]);

		expect(first).toBe(second);
		expect(transformCalls).toBe(1);
	});

	it("PC16 rejects required queue IDs that do not match delivery order", async () => {
		const agent = new Agent({
			initialState: {
				model: createModel(),
				messages: [{ role: "user", content: "continue", timestamp: 1 }],
			},
			steeringMode: "all",
			streamFn: () => new MockAssistantStream(createAssistantMessage()),
		});
		agent.steer({
			queueItemId: "steer-1",
			message: { role: "user", content: "first", timestamp: 2 },
		});
		agent.steer({
			queueItemId: "steer-2",
			message: { role: "user", content: "second", timestamp: 3 },
		});

		await expect(
			agent.prepareContinuation(agent.state.messages, {
				requiredQueueItemIds: ["steer-2", "steer-1"],
			}),
		).rejects.toThrow("Required queue item order does not match the pending delivery order");
	});

	it("PC15 leaves append-only state unchanged when preparation is released", async () => {
		const agent = new Agent({
			appendOnlyContext: true,
			initialState: {
				model: createModel(),
				messages: [{ role: "user", content: "replacement", timestamp: 2 }],
			},
			streamFn: () => new MockAssistantStream(createAssistantMessage()),
		});
		agent.appendOnlyContext?.syncMessages([{ role: "user", content: "cached", timestamp: 1 }]);
		const before = agent.appendOnlyContext?.log.toMessages();

		const preparation = await agent.prepareContinuation(agent.state.messages);
		agent.releasePreparedContinuation(preparation);

		expect(agent.appendOnlyContext?.log.toMessages()).toEqual(before);
	});

	it("PC13 rejects a second dispatch of the same handle", async () => {
		let providerCalls = 0;
		let responseStream: EventStream<AssistantMessageEvent, AssistantMessage> | undefined;
		const agent = new Agent({
			initialState: {
				model: createModel(),
				messages: [{ role: "user", content: "continue", timestamp: 1 }],
			},
			streamFn: () => {
				providerCalls++;
				responseStream = new EventStream(
					(event) => event.type === "done" || event.type === "error",
					(event) => {
						if (event.type === "done") return event.message;
						if (event.type === "error") return event.error;
						throw new Error("Unexpected event type");
					},
				);
				return responseStream;
			},
		});
		const preparation = await agent.prepareContinuation(agent.state.messages);
		const firstDispatch = agent.dispatchPreparedContinuation(preparation);
		await Promise.resolve();

		await expect(agent.dispatchPreparedContinuation(preparation)).rejects.toThrow(
			"Prepared continuation is already dispatching",
		);
		expect(providerCalls).toBe(1);

		responseStream?.push({ type: "done", reason: "stop", message: createAssistantMessage() });
		await firstDispatch;
		expect(providerCalls).toBe(1);
	});
});
