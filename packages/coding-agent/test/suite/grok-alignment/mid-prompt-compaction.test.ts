import {
	type AssistantMessage,
	CONTEXT_SAFETY_TOKENS,
	calculateContextBudget,
	contextFingerprint,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_POLICY,
	needsRoomForOutput,
	OUTPUT_HEADROOM_FACTOR,
	OUTPUT_HEADROOM_MAX_TOKENS,
} from "../../../src/core/compaction/compaction-policy.ts";
import type {
	ContextMaintenanceAction,
	ContextMaintenanceBudget,
} from "../../../src/core/compaction/context-maintenance.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Auto-compaction used to be consulted only after `agent.prompt()` returned. A single prompt routinely
 * runs dozens of tool-calling turns, so a long task could drive the context to 97% of the window with
 * zero compactions until responses were truncated to three tokens. `AgentSession._installContextGuard`
 * moves the check to every turn via the `shouldStopAfterTurn` hook; these tests pin that behaviour.
 */

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** An assistant message carrying a chosen context size, as the provider would report it. */
function assistantWithUsage(
	harness: Harness,
	totalTokens: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
) {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(totalTokens),
	} as AssistantMessage;
}

/** The installed policy is evaluated against a signed request snapshot, not a timestamp. */
async function askGuard(harness: Harness, message: AssistantMessage): Promise<boolean> {
	const model = harness.getModel();
	const context = {
		systemPrompt: harness.session.systemPrompt,
		tools: harness.session.agent.state.tools,
		messages: [message],
	};
	if (message.usage) message.usageContextFingerprint = contextFingerprint(context, model);
	return (
		calculateContextBudget(model, context, harness.session.agent.getContextBudgetOptions?.(model)).decision ===
		"context_limit"
	);
}

describe("needsRoomForOutput (compaction judgement)", () => {
	const policy = DEFAULT_COMPACTION_POLICY; // threshold 85%

	it("rule A: fires once history crosses the percentage threshold", () => {
		expect(needsRoomForOutput(85_000, 100_000, 0, policy)).toBe(true);
		expect(needsRoomForOutput(84_999, 100_000, 0, policy)).toBe(false);
	});

	it("rule B: fires when free space cannot hold one capped response, even far below the threshold", () => {
		// 90k of a 128k window is 70% — below 85% — but a capped 32k output reservation cannot fit in the
		// 38k that is left once the 1.2x safety factor is applied.
		expect(needsRoomForOutput(90_000, 128_000, 60_000, policy)).toBe(true);
		// Same usage as before, small output budget: plenty of room, no compaction warranted.
		expect(needsRoomForOutput(60_000, 128_000, 4_000, policy)).toBe(false);
	});

	it("rule B honours the headroom factor exactly", () => {
		const window = 100_000;
		// Chosen so the boundary lands well below the 85% threshold, isolating rule B: needed is 24k, so
		// the boundary is at 76k used (76%). A smaller maxTokens would put the boundary above 85% and rule
		// A would fire first, testing nothing.
		const maxTokens = 20_000;
		const needed = maxTokens + Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(maxTokens * (OUTPUT_HEADROOM_FACTOR - 1)));
		// free == needed -> still fits (strict less-than)
		expect(needsRoomForOutput(window - needed, window, maxTokens, policy)).toBe(false);
		// one token less free -> does not fit
		expect(needsRoomForOutput(window - needed + 1, window, maxTokens, policy)).toBe(true);
	});

	it("caps the reserved output budget so raising provider maxTokens does not shrink at 40%", () => {
		const window = 131_072;
		const maxTokens = 65_536;
		const cappedNeeded = OUTPUT_HEADROOM_MAX_TOKENS * OUTPUT_HEADROOM_FACTOR;
		// With the cap, 80k used leaves 51k free and should not trigger. Without the cap, 65k*1.2 would
		// demand 78k free and this would fire at only ~61% usage.
		expect(needsRoomForOutput(80_000, window, maxTokens, policy)).toBe(false);
		expect(needsRoomForOutput(window - cappedNeeded + 1, window, maxTokens, policy)).toBe(true);
	});

	it("degrades safely on unknown model metadata", () => {
		// No window reported: nothing can be judged, so never force a compaction.
		expect(needsRoomForOutput(999_999, 0, 16_000, policy)).toBe(false);
		// No output budget reported: rule B is inapplicable, rule A still holds.
		expect(needsRoomForOutput(10_000, 100_000, 0, policy)).toBe(false);
		expect(needsRoomForOutput(90_000, 100_000, 0, policy)).toBe(true);
		// Usage beyond the window is over the threshold by definition.
		expect(needsRoomForOutput(200_000, 100_000, 0, policy)).toBe(true);
	});
});

describe("mid-prompt context guard", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is installed on the agent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(typeof harness.session.agent.getContextBudgetOptions).toBe("function");
	});

	it("stops the loop once a turn reports a context that leaves no room to answer", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// faux default window is 128000; 120k used leaves 8k, less than maxTokens(16384) * 1.2.
		expect(await askGuard(harness, assistantWithUsage(harness, 120_000))).toBe(true);
	});

	it("leaves a comfortable context alone", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(await askGuard(harness, assistantWithUsage(harness, 20_000))).toBe(false);
	});

	it("repeated budget checks do not spend the session reduction allowance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as { _contextMaintenanceBudget: ContextMaintenanceBudget };
		const results: boolean[] = [];
		for (let i = 0; i < 5; i++) {
			results.push(await askGuard(harness, assistantWithUsage(harness, 120_000)));
		}
		// The guard keeps stopping the loop while the context has no room, but only the first three stops
		// buy a compaction. Past that the budget is spent and further stops request a rescue shake, which
		// costs no model call (see AgentSession.shake).
		expect(results).toEqual([true, true, true, true, true]);
		expect(internals._contextMaintenanceBudget.softCompactionOperationsStarted).toBe(0);
	});

	it("still rejects an oversized request when auto-compaction is disabled", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		expect(await askGuard(harness, assistantWithUsage(harness, 127_000))).toBe(true);
	});

	it("ignores turns whose usage cannot be trusted", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Aborted and errored turns report stale or zero usage; erroring is the retry path's business.
		expect(await askGuard(harness, assistantWithUsage(harness, 127_000, "aborted"))).toBe(false);
		expect(await askGuard(harness, assistantWithUsage(harness, 127_000, "error"))).toBe(false);
		const noUsage = assistantWithUsage(harness, 127_000);
		(noUsage as { usage?: unknown }).usage = undefined;
		expect(await askGuard(harness, noUsage)).toBe(false);
	});

	it("end to end: a prompt whose context fills mid-run gets compacted instead of running to exhaustion", async () => {
		// Needs real auth wiring: this drives prompt(), unlike tests that invoke one soft-compaction operation.
		const harness = await createHarness();
		harnesses.push(harness);
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		// Seed history so prepareCompaction has something to summarize.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start the long task" }],
			timestamp: Date.now() - 1000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// Every provider call reports a nearly-full context. Without the guard the loop would keep going
		// (and in production keep truncating); with it, the run stops and the post-run path compacts.
		let calls = 0;
		harness.session.agent.streamFunction = (model) => {
			calls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage(calls === 1 ? "working" : "compaction summary"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: calls === 1 ? usage(125_000) : usage(10),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		await harness.session.prompt("do the long task");
		await harness.session.agent.waitForIdle();

		const compactions = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions.length).toBeGreaterThan(0);
	});

	/**
	 * The guard stops the loop and the post-run path decides what to do about it. Those two must agree on
	 * when the context is too tight, or the guard cuts a run short for a reduction that never happens.
	 *
	 * Run 2026-08-18__00-33-41 is what disagreement looks like: the guard used the output-headroom rule
	 * while threshold compaction only tested the percentage threshold, so 13 tasks sitting around 75% of
	 * the window — under the percentage threshold but with less than one reply of headroom — had the loop
	 * stopped mid-tool-call and then nothing done about it. 12 of the 13 failed.
	 */
	it("reduces context whenever the guard stops for it, including below the percentage threshold", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		const model = harness.getModel();
		const window = model.contextWindow;
		const maxTokens = model.maxTokens;
		// Below the 85% threshold, but with less free space than one full reply needs.
		const used = window - Math.floor(maxTokens * OUTPUT_HEADROOM_FACTOR) + 1;
		expect(used / window).toBeLessThan(0.85);

		// The guard wants to stop here.
		expect(await askGuard(harness, assistantWithUsage(harness, used))).toBe(true);

		// And the post-run path must act on it rather than declining. Seed history so a reduction has
		// something to work with, then drive one prompt at that usage level.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "a".repeat(400) }],
			timestamp: Date.now() - 1000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let calls = 0;
		harness.session.agent.streamFunction = (m) => {
			calls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(calls === 1 ? "working" : "summary"),
						api: m.api,
						provider: m.provider,
						model: m.id,
						usage: calls === 1 ? usage(used) : usage(10),
					},
				});
			});
			return stream;
		};

		await harness.session.prompt("go");
		await harness.session.agent.waitForIdle();

		// Either mechanism counts: shake is the cheap first attempt, compaction the fallback. What must not
		// happen is neither.
		const reductions = harness.sessionManager
			.getEntries()
			.filter((e) => e.type === "compaction" || e.type === "shake");
		expect(reductions.length).toBeGreaterThan(0);
	});

	/**
	 * If the guard stopped a turn that was still issuing tool calls, a successful shake is not the end of
	 * the task — it is just the pit stop. This is the bug exposed by run 2026-08-18__09-53-51: ten tasks
	 * got a threshold shake, then the post-run path returned false and the run ended on `toolUse`.
	 */
	it("continues after a threshold shake that fixed a mid-action context stop", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Seed a large tool result so shake has something to remove, then add a tail so the result is not
		// inside the recent protected suffix.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "run the thing" }],
			timestamp: Date.now() - 3000,
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "large-result",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(360_000) }],
			isError: false,
			timestamp: Date.now() - 2000,
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "z".repeat(80_000) }],
			timestamp: Date.now() - 1000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const model = harness.getModel();
		const used = model.contextWindow - Math.floor(model.maxTokens * OUTPUT_HEADROOM_FACTOR) + 1;
		const msg = assistantWithUsage(harness, used, "toolUse");
		const internals = harness.session as unknown as {
			_checkCompaction: (
				message: AssistantMessage,
				skipAbortedCheck?: boolean,
				continueAfterReduction?: boolean,
			) => Promise<ContextMaintenanceAction>;
		};

		await expect(internals._checkCompaction(msg, true, true)).resolves.toBe("continue");
		const shakes = harness.sessionManager.getEntries().filter((e) => e.type === "shake");
		expect(shakes).toHaveLength(1);
	});

	it("does not continue after a threshold shake for a completed answer", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "large-result",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(80_000) }],
			isError: false,
			timestamp: Date.now() - 1000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const model = harness.getModel();
		const used = model.contextWindow - Math.floor(model.maxTokens * OUTPUT_HEADROOM_FACTOR) + 1;
		const msg = assistantWithUsage(harness, used, "stop");
		const internals = harness.session as unknown as {
			_checkCompaction: (
				message: AssistantMessage,
				skipAbortedCheck?: boolean,
				continueAfterReduction?: boolean,
			) => Promise<ContextMaintenanceAction>;
		};

		await expect(internals._checkCompaction(msg, true, false)).resolves.toBe("wait");
	});
});
