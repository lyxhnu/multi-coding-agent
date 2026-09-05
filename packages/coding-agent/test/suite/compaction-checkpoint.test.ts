import { createAssistantMessageEventStream, fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPrefixCheckpoint,
	type PrefixSummaryCheckpoint,
	reusePrefixCheckpoint,
	validatePrefixCheckpoint,
} from "../../src/core/compaction/checkpoint.ts";
import { compact, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTaskNoteBatchId } from "../../src/core/task-note-projection.ts";
import { createHarness, type Harness } from "./harness.ts";

function appendCheckpointEnvelope(harness: Harness, compactionPrefix: PrefixSummaryCheckpoint): void {
	const checkpointId = "test-prefix-checkpoint";
	const objective = harness.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (!objective) throw new Error("missing objective");
	harness.sessionManager.appendCustomEntry("context-rollover-checkpoint", {
		version: 1,
		checkpoint: {
			version: 1,
			checkpointId,
			promptGeneration: 0,
			contextEpoch: 0,
			coveredStartEntryId: compactionPrefix.coveredStartEntryId,
			coveredEndEntryId: compactionPrefix.coveredEndEntryId,
			coveredEntryIds: [compactionPrefix.coveredStartEntryId, compactionPrefix.coveredEndEntryId],
			sourcePrefixFingerprint: "test-source",
			todoStateEntryId: null,
			todoStateFingerprint: "test-todo",
			requestConfigFingerprint: "test-config",
			compactionPrefix,
			note: {
				version: 1,
				objective: { text: "Keep deployment private", sourceEntryIds: [objective.id] },
				userConstraints: [],
				acceptanceCriteria: { status: "not_specified", items: [] },
				decisions: [],
				completedWork: [],
				currentState: { text: "Compaction pending", evidenceEntryIds: [objective.id] },
				failedAttempts: [],
				nextAction: { text: "Continue compaction", evidenceEntryIds: [] },
				historyRefs: [],
			},
		},
		taskNoteBatch: { version: 1, batchId: createTaskNoteBatchId(checkpointId, []), events: [] },
	});
}

describe("memory-context-integrity: prefix checkpoint", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses.splice(0)) await h.cleanup();
	});
	async function seed() {
		const h = await createHarness({
			tools: [],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 2000 } },
		});
		harnesses.push(h);
		const first = h.sessionManager.appendMessage({
			role: "user",
			content: "PREFIX ORIGINAL: keep deployment private",
			timestamp: 1,
		});
		h.sessionManager.appendMessage(fauxAssistantMessage("prefix progress"));
		h.sessionManager.appendMessage({ role: "user", content: "retained tail", timestamp: 2 });
		const entries = h.sessionManager.getBranch();
		const preparation = prepareCompaction(entries, h.settingsManager.getCompactionSettings())!;
		const usage = {
			input: 11,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 },
		};
		const checkpoint = createPrefixCheckpoint(entries, preparation, "Deployment must remain private", usage);
		return { h, first, preparation, checkpoint };
	}
	it("T02/T05 reuses checkpoints after tail append and source export", async () => {
		const { h, checkpoint } = await seed();
		h.sessionManager.appendMessage(fauxAssistantMessage("new progress"));
		h.sessionManager.appendMessage({ role: "user", content: "new question", timestamp: 3 });
		const restored = SessionManager.open(h.session.exportToJsonl(`${h.tempDir}/checkpoint.jsonl`));
		expect(validatePrefixCheckpoint(restored.getBranch(), checkpoint)).toBe(true);
		const preparation = prepareCompaction(restored.getBranch(), h.settingsManager.getCompactionSettings())!;
		const incremental = reusePrefixCheckpoint(restored.getBranch(), preparation, checkpoint)!;
		expect(incremental.previousSummary).toContain("remain private");
		expect(JSON.stringify(incremental.messagesToSummarize)).not.toContain("PREFIX ORIGINAL");
		expect(JSON.stringify(incremental)).toContain("retained tail");
	});
	it("T03 invalidates a same-length changed source and a different base compaction", async () => {
		const { h, first, checkpoint } = await seed();
		h.sessionManager.appendShake(
			[{ kind: "block", targetId: first, blockIndex: -1, text: "source replaced" }],
			1,
			"manual",
		);
		expect(validatePrefixCheckpoint(h.sessionManager.getBranch(), checkpoint)).toBe(false);
		h.sessionManager.appendCompaction("other base", first, 100);
		expect(validatePrefixCheckpoint(h.sessionManager.getBranch(), checkpoint)).toBe(false);
	});
	it("T04 does not attach a late result to a sibling branch", async () => {
		const { h, first, checkpoint } = await seed();
		h.sessionManager.branch(first);
		h.sessionManager.appendMessage(fauxAssistantMessage("sibling"));
		expect(validatePrefixCheckpoint(h.sessionManager.getBranch(), checkpoint)).toBe(false);
	});
	it("T02/T07 no new tail reuses summary with no provider request and keeps prefix usage", async () => {
		const { h, preparation, checkpoint } = await seed();
		const incremental = reusePrefixCheckpoint(h.sessionManager.getBranch(), preparation, checkpoint)!;
		h.setResponses([fauxAssistantMessage("must remain queued")]);
		const result = await compact(
			incremental,
			h.getModel(),
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamSimple,
		);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(result.summary).toContain(checkpoint.summary);
		expect(result.usage).toEqual(checkpoint.usage);
	});
	it("T07 accounts for a completed prefix before reuse and counts it only once after commit", async () => {
		const { h, preparation, checkpoint } = await seed();
		const before = h.session.getSessionStats();
		appendCheckpointEnvelope(h, checkpoint);
		expect(h.session.getSessionStats().cost - before.cost).toBe(checkpoint.usage!.cost.total);
		const incremental = reusePrefixCheckpoint(h.sessionManager.getBranch(), preparation, checkpoint)!;
		const result = await compact(
			incremental,
			h.getModel(),
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamSimple,
		);
		h.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			false,
			result.usage,
		);
		expect(h.session.getSessionStats().cost - before.cost).toBe(checkpoint.usage!.cost.total);
		expect(h.session.getSessionStats().tokens.input - before.tokens.input).toBe(checkpoint.usage!.input);
	});
	it.each(["branch", "edit", "abort", "dispose"] as const)(
		"T01/T04/T05 bounds prefire lifecycle during %s",
		async (action) => {
			const { h, first } = await seed();
			let calls = 0;
			let finish!: () => void;
			let signal: AbortSignal | undefined;
			h.session.agent.streamFunction = (model, _context, options) => {
				calls++;
				signal = options?.signal;
				const stream = createAssistantMessageEventStream();
				const message = {
					...fauxAssistantMessage("late prefix"),
					api: model.api,
					model: model.id,
					provider: model.provider,
				};
				finish = () => stream.push({ type: "done", reason: "stop", message });
				signal?.addEventListener(
					"abort",
					() => stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }),
					{ once: true },
				);
				return stream;
			};
			const internals = h.session as unknown as {
				_maybeStartTwoPassPrefire(): void;
				_twoPassPrefireInFlight: boolean;
			};
			internals._maybeStartTwoPassPrefire();
			internals._maybeStartTwoPassPrefire();
			await vi.waitFor(() => expect(calls).toBe(1));
			if (action === "branch") {
				h.sessionManager.branch(first);
				h.sessionManager.appendMessage({ role: "user", content: "sibling work", timestamp: 3 });
				finish();
			} else if (action === "edit") {
				const source = h.sessionManager.getEntry(first)!;
				if (source.type !== "message" || source.message.role !== "user") throw new Error("invalid fixture");
				source.message.content = "in-place source edit while prefix request is in flight";
				finish();
			} else {
				await h.session[action]();
				expect(signal?.aborted).toBe(true);
			}
			await vi.waitFor(() => expect(internals._twoPassPrefireInFlight).toBe(false));
			expect(
				h.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "context-rollover-checkpoint"),
			).toBe(false);
			expect(calls).toBe(1);
		},
	);
	it("T07 records nonzero usage for both stages without charging the prefix twice", async () => {
		const { h, checkpoint } = await seed();
		appendCheckpointEnvelope(h, checkpoint);
		h.sessionManager.appendMessage(fauxAssistantMessage("tail work"));
		h.sessionManager.appendMessage({ role: "user", content: "new tail", timestamp: 4 });
		const entries = h.sessionManager.getBranch();
		const preparation = prepareCompaction(entries, h.settingsManager.getCompactionSettings())!;
		const incremental = reusePrefixCheckpoint(entries, preparation, checkpoint)!;
		h.setResponses([fauxAssistantMessage("new combined summary"), fauxAssistantMessage("new tail summary")]);
		const result = await compact(
			incremental,
			h.getModel(),
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamSimple,
		);
		expect(result.usage!.input).toBeGreaterThan(checkpoint.usage!.input);
		h.sessionManager.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			false,
			result.usage,
		);
		expect(h.session.getSessionStats().tokens.input).toBe(result.usage!.input);
	});
});
