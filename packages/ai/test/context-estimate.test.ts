import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { calculateContextBudget, contextFingerprint, estimateContextTokens } from "../src/utils/estimate.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		};

		expect(estimateContextTokens(context, model)).toEqual({
			tokens: 1_005,
			usageTokens: 0,
			trailingTokens: 1_005,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_899);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		};

		(context.messages[3] as AssistantMessage).usageContextFingerprint = contextFingerprint(
			{ ...context, messages: context.messages.slice(0, 4) },
			model,
		);
		expect(estimateContextTokens(context, model)).toEqual({
			tokens: 2_001,
			usageTokens: 2_000,
			trailingTokens: 1,
			lastUsageIndex: 3,
		});
	});

	it.each(["model", "system", "tools", "prefix"])(
		"B04/B05 invalidates usage on %s change without relying on timestamps",
		(change) => {
			const assistant = createAssistant(1, 9000);
			const context: Context = {
				systemPrompt: "original",
				messages: [{ role: "user", content: "old", timestamp: 1 }, assistant],
			};
			assistant.usageContextFingerprint = contextFingerprint(context, model);
			expect(estimateContextTokens(context, model).usageTokens).toBe(9000);
			const selected = change === "model" ? { ...model, id: "other" } : model;
			if (change === "system") context.systemPrompt = "changed";
			if (change === "tools")
				context.tools = [{ name: "new", description: "new tool", parameters: { type: "object" } }];
			if (change === "prefix") context.messages[0] = { role: "user", content: "new", timestamp: 1 };
			expect(estimateContextTokens(context, selected).usageTokens).toBe(0);
		},
	);

	it("B01/B02 includes system, tools, images and trailing parallel results exactly once", () => {
		const assistant = createAssistant(1, 1200);
		const context: Context = {
			systemPrompt: "system",
			tools: [{ name: "read", description: "read", parameters: {} }],
			messages: [assistant],
		};
		assistant.usageContextFingerprint = contextFingerprint(context, model);
		context.messages.push(
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "one",
				isError: false,
				content: [{ type: "text", text: "a".repeat(4000) }],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "two",
				isError: false,
				content: [{ type: "image", mimeType: "image/png", data: "" }],
				timestamp: 2,
			},
		);
		expect(estimateContextTokens(context, model).tokens).toBe(3400);
	});

	it("B11 distinguishes output target from provider maximum and one safety margin", () => {
		const budget = calculateContextBudget({ ...model, contextWindow: 131072, maxTokens: 65536 }, { messages: [] });
		expect(budget.outputReserveTokens).toBe(32768);
		expect(budget.safetyTokens).toBe(6554);
		expect(budget.availableOutputTokens).toBe(131072 - budget.safetyTokens);
		expect(budget.decision).toBe("fits");
	});
	it("B08 labels unknown model limits", () => {
		expect(calculateContextBudget({ ...model, contextWindow: 0, maxTokens: 0 }, { messages: [] })).toMatchObject({
			decision: "unknown",
			availableOutputTokens: null,
			unknownFields: ["contextWindow", "maxTokens"],
		});
	});
	it.each([-1, 0, 1])("B07 exact capacity boundary with %i input token delta", (delta) => {
		const candidate = { ...model, contextWindow: 10000, maxTokens: 1000 };
		const context: Context = { messages: [{ role: "user", content: "x".repeat((4904 + delta) * 4), timestamp: 0 }] };
		const budget = calculateContextBudget(candidate, context);
		expect(budget.decision).toBe(delta > 0 ? "context_limit" : "fits");
		expect(buildBaseOptions(candidate, context).maxTokens).toBe(delta > 0 ? 999 : 1000);
	});
	it.each(["中文约束不得丢失", "Keep the original constraint", "const value = { enabled: true };"])(
		"B04/B08 estimates %s when signed usage is zero",
		(text) => {
			const assistant = createAssistant(1, 0);
			const context: Context = {
				systemPrompt: "system",
				messages: [{ role: "user", content: text, timestamp: 0 }, assistant],
			};
			assistant.usageContextFingerprint = contextFingerprint(context, model);
			expect(estimateContextTokens(context, model)).toMatchObject({
				lastUsageIndex: null,
				usageTokens: 0,
				tokens: Math.ceil(text.length / 4) + 3,
			});
		},
	);
});
