import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * The threshold path tries the free reduction before paying for a summary.
 *
 * Compaction costs a provider request on a wall-clock budget and rewrites the whole prefix, while
 * most threshold crossings are driven by a few oversized tool results. When shake frees enough that
 * neither trigger still fires, the summary request is skipped outright.
 */

type SessionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
};

const CONTEXT_WINDOW = 128_000;
/** Clears the default 85%-of-window auto-compact threshold. */
const OVER_THRESHOLD_TOKENS = Math.round(CONTEXT_WINDOW * 0.86);
/** High enough that even a small shake leaves usage above the threshold. */
const FAR_OVER_THRESHOLD_TOKENS = CONTEXT_WINDOW - 1_000;
/** Comfortably below the threshold, so neither reduction path should engage. */
const UNDER_THRESHOLD_TOKENS = Math.round(CONTEXT_WINDOW * 0.4);

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(harness: Harness, totalTokens: number, timestamp?: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("ok", { stopReason: "stop", timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

/**
 * A branch with one oversized tool result and a tail large enough to push it out of
 * `DEFAULT_SHAKE_CONFIG`'s 16k protect window but inside its 100k cache guard.
 */
function seedSession(harness: Harness, toolResultTokens: number, totalTokens = OVER_THRESHOLD_TOKENS): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "s".repeat(Math.max(0, totalTokens - toolResultTokens - 20000) * 4) }],
		timestamp: now - 5_000,
	});
	const assistant = createAssistant(harness, 100, now - 4_000);
	assistant.content = [{ type: "text", text: "calling the tool" }];
	harness.sessionManager.appendMessage(assistant);
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "y".repeat(toolResultTokens * 4) }],
		isError: false,
		timestamp: now - 3_000,
	};
	harness.sessionManager.appendMessage(toolResult);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "z".repeat(20_000 * 4) }],
		timestamp: now - 2_000,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** Counts summary requests so a skipped compaction is provable, not just inferred from events. */
function countSummaryCalls(harness: Harness): () => number {
	let calls = 0;
	harness.session.agent.streamFunction = (model) => {
		calls++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("summary of the conversation"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				},
			});
		});
		return stream;
	};
	return () => calls;
}

describe("threshold compaction tries shake first", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function makeHarness(): Promise<Harness> {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 20000 } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("skips the summary request when shake frees enough room", async () => {
		const harness = await makeHarness();
		seedSession(harness, 40_000);
		const countCalls = countSummaryCalls(harness);
		const internals = harness.session as unknown as SessionInternals;

		const compacted = await internals._checkCompaction(createAssistant(harness, OVER_THRESHOLD_TOKENS));

		expect(compacted).toBe(false);
		const shakes = harness.eventsOfType("shake");
		expect(shakes).toHaveLength(1);
		expect(shakes[0].reason).toBe("threshold");
		expect(shakes[0].tokensSaved).toBeGreaterThan(20_000);
		// The point of the whole path: no model call, no compaction.
		expect(countCalls()).toBe(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("still compacts when shake cannot free enough", async () => {
		const harness = await makeHarness();
		seedSession(harness, 5_000, FAR_OVER_THRESHOLD_TOKENS);
		const countCalls = countSummaryCalls(harness);
		const internals = harness.session as unknown as SessionInternals;

		await internals._checkCompaction(createAssistant(harness, FAR_OVER_THRESHOLD_TOKENS));

		// Shake ran and helped a little, but the threshold still holds, so compaction proceeds.
		expect(harness.eventsOfType("shake")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(countCalls()).toBeGreaterThan(0);
	});

	it("compacts without a shake event when nothing is eligible", async () => {
		const harness = await makeHarness();
		// A tool result under the savings floor leaves no eligible region.
		seedSession(harness, 100);
		const internals = harness.session as unknown as SessionInternals;

		countSummaryCalls(harness);
		await internals._checkCompaction(createAssistant(harness, OVER_THRESHOLD_TOKENS));

		expect(harness.eventsOfType("shake")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
	});

	it("does nothing while usage stays below the threshold", async () => {
		const harness = await makeHarness();
		seedSession(harness, 40000, UNDER_THRESHOLD_TOKENS);
		const countCalls = countSummaryCalls(harness);
		const internals = harness.session as unknown as SessionInternals;

		const compacted = await internals._checkCompaction(createAssistant(harness, UNDER_THRESHOLD_TOKENS));

		expect(compacted).toBe(false);
		expect(harness.eventsOfType("shake")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(countCalls()).toBe(0);
	});

	it("does not shake again on a second crossing once the regions are spent", async () => {
		const harness = await makeHarness();
		seedSession(harness, 40_000);
		countSummaryCalls(harness);
		const internals = harness.session as unknown as SessionInternals;

		await internals._checkCompaction(createAssistant(harness, OVER_THRESHOLD_TOKENS));
		expect(harness.eventsOfType("shake")).toHaveLength(1);

		// The recorded redactions mark the region as already shaken, so the second pass finds nothing
		// and falls through instead of re-shaking the same result.
		harness.sessionManager.appendMessage({ role: "user", content: "tail".repeat(40000), timestamp: Date.now() });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await internals._checkCompaction(createAssistant(harness, OVER_THRESHOLD_TOKENS));
		expect(harness.eventsOfType("shake")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
	});
});
