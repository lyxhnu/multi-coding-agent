import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type CheckpointInternals = {
	_maybeStartTwoPassPrefire: () => void;
	_contextCheckpointPromise?: Promise<void>;
};

function checkpointOutput(objectiveEntryId: string, state: string, noteUpdateCandidates: unknown[] = []): string {
	return JSON.stringify({
		checkpoint: {
			version: 1,
			objective: { text: "implement rollover", sourceEntryIds: [objectiveEntryId] },
			userConstraints: [],
			acceptanceCriteria: { status: "not_specified", items: [] },
			decisions: [],
			completedWork: [],
			currentState: { text: state, evidenceEntryIds: [objectiveEntryId] },
			failedAttempts: [],
			nextAction: { text: "continue implementation", evidenceEntryIds: [] },
			historyRefs: [],
		},
		noteUpdateCandidates,
	});
}

describe("Context Rollover checkpoint", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("CP02 persists the started operation before calling the checkpoint model", async () => {
		const harness = await createHarness({
			models: [{ id: "checkpoint", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const objectiveEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("work in progress"),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
			timestamp: 2,
		});
		let sawStartedBeforeProvider = false;
		harness.session.agent.streamFunction = (model) => {
			sawStartedBeforeProvider = harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "context_operation" && entry.state === "started");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage(checkpointOutput(objectiveEntryId, "Current implementation state.")),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const internals = harness.session as unknown as CheckpointInternals;
		internals._maybeStartTwoPassPrefire();
		await internals._contextCheckpointPromise;

		expect(sawStartedBeforeProvider).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_operation")
				.map((entry) => (entry.type === "context_operation" ? entry.state : "")),
		).toEqual(["started", "finished"]);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "context-rollover-checkpoint"),
		).toBe(true);
	});

	it("CP03 incrementally refreshes a prefix checkpoint at most once", async () => {
		const harness = await createHarness({
			models: [{ id: "checkpoint-refresh", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const objectiveEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: "first work item",
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("first implementation state"),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
			timestamp: 2,
		});
		let modelCalls = 0;
		harness.session.agent.streamFunction = (model) => {
			modelCalls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage(checkpointOutput(objectiveEntryId, `checkpoint-${modelCalls}`)),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const internals = harness.session as unknown as CheckpointInternals;
		internals._maybeStartTwoPassPrefire();
		await internals._contextCheckpointPromise;
		const firstCheckpoint = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "context-rollover-checkpoint")
			.at(-1);
		expect(firstCheckpoint).toBeDefined();

		harness.sessionManager.appendMessage({
			role: "user",
			content:
				"A sufficiently large new tail records the next concrete implementation state and verification plan. ".repeat(
					80,
				),
			timestamp: 4,
		});
		internals._maybeStartTwoPassPrefire();
		await internals._contextCheckpointPromise;
		const checkpointsAfterRefresh = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "context-rollover-checkpoint");
		expect(modelCalls).toBe(2);
		expect(checkpointsAfterRefresh).toHaveLength(2);
		expect(checkpointsAfterRefresh.at(-1)?.id).not.toBe(firstCheckpoint?.id);

		harness.sessionManager.appendMessage({
			role: "user",
			content: "Another sufficiently large tail that would otherwise request another refresh. ".repeat(80),
			timestamp: 5,
		});
		internals._maybeStartTwoPassPrefire();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(modelCalls).toBe(2);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_operation" && entry.operationKind === "checkpoint"),
		).toHaveLength(4);
	});

	it("NC07 rejects the entire checkpoint envelope when one Note candidate is invalid", async () => {
		const harness = await createHarness({
			models: [{ id: "checkpoint-atomic", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const objectiveEntryId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("work in progress"),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
			timestamp: 2,
		});
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(
							checkpointOutput(objectiveEntryId, "unfinished", [
								{
									operation: "upsert",
									kind: "state",
									key: "tests",
									text: "Tests pass.",
									sourceRefs: [{ entryId: objectiveEntryId }],
									evidenceRefs: [],
								},
							]),
						),
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				});
			});
			return stream;
		};

		const internals = harness.session as unknown as CheckpointInternals;
		internals._maybeStartTwoPassPrefire();
		await internals._contextCheckpointPromise;

		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "context-rollover-checkpoint"),
		).toBe(false);
	});
});
