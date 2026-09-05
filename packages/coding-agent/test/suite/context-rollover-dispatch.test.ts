import { type ContextBudget, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ContextRolloverBundle,
	createContextRolloverCheckpointEnvelope,
	createContextRolloverDispatchId,
	fingerprintContextRolloverValue,
} from "../../src/core/context-rollover.ts";
import { PendingDeliveryStore } from "../../src/core/pending-delivery.ts";
import { buildSessionContext, type ContextRolloverEntry, type SessionEntry } from "../../src/core/session-manager.ts";
import { buildTaskNoteProjection, createTaskScopeId } from "../../src/core/task-note-projection.ts";
import { createHarness, type Harness } from "./harness.ts";

type RolloverInternals = {
	_runContextRollover: (
		maintenanceId: string,
		trigger: {
			triggerId: string;
			cause: "budget_limit";
			phase: "mid_run";
			continuation: "required";
			signal?: AbortSignal;
		},
		outcome: {
			outcome: "blocked";
			requestFingerprint: string;
			budget: ContextBudget;
			reason: "methods_exhausted";
			attempts: [];
		},
	) => Promise<boolean>;
	_resumePreparedContextRollover: () => Promise<void>;
	_runContextMaintenance: (trigger: {
		triggerId: string;
		cause: "budget_limit";
		phase: "mid_run";
		continuation: "required";
	}) => Promise<"stop">;
};

function limitedBudget(): ContextBudget {
	return {
		tokens: 9000,
		usageTokens: 9000,
		trailingTokens: 0,
		lastUsageIndex: 0,
		contextWindow: 10000,
		modelMaxOutputTokens: 1000,
		requestedMaxOutputTokens: 1000,
		unknownFields: [],
		outputReserveTokens: 1000,
		safetyTokens: 0,
		availableOutputTokens: 0,
		decision: "context_limit",
	};
}

function requestConfigFingerprint(harness: Harness): string {
	return (harness.session as unknown as { _requestConfigFingerprint: () => string })._requestConfigFingerprint();
}

function createCheckpointEnvelopeFixture(input: {
	checkpointId: string;
	promptGeneration: number;
	contextEpoch: number;
	branch: readonly SessionEntry[];
	coveredStartEntryId: string;
	coveredEndEntryId: string;
	summary: string;
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	requestConfigFingerprint: string;
	nextAction?: string;
}) {
	const objective = input.branch.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (objective?.type !== "message" || objective.message.role !== "user") throw new Error("missing objective");
	const objectiveText =
		typeof objective.message.content === "string"
			? objective.message.content
			: objective.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	const taskNoteScope = {
		taskScopeId: createTaskScopeId(objective.id),
		promptGeneration: input.promptGeneration,
	};
	const projection = buildTaskNoteProjection({ events: [], scope: taskNoteScope });
	if (projection.status !== "valid") throw new Error("invalid fixture projection");
	return createContextRolloverCheckpointEnvelope({
		checkpointId: input.checkpointId,
		promptGeneration: input.promptGeneration,
		contextEpoch: input.contextEpoch,
		branch: input.branch,
		coveredStartEntryId: input.coveredStartEntryId,
		coveredEndEntryId: input.coveredEndEntryId,
		output: {
			checkpoint: {
				version: 1,
				objective: { text: objectiveText, sourceEntryIds: [objective.id] },
				userConstraints: [],
				acceptanceCriteria: { status: "not_specified", items: [] },
				decisions: [],
				completedWork: [],
				currentState: { text: input.summary, evidenceEntryIds: [objective.id] },
				failedAttempts: [],
				nextAction: {
					text: input.nextAction ?? "Continue the unfinished task from the verified current state.",
					evidenceEntryIds: [],
				},
				historyRefs: [],
			},
			noteUpdateCandidates: [],
		},
		taskNoteScope,
		taskNoteProjection: projection.snapshot,
		taskNoteEvents: [],
		todoStateEntryId: input.todoStateEntryId,
		todoStateFingerprint: input.todoStateFingerprint,
		requestConfigFingerprint: input.requestConfigFingerprint,
	});
}

describe("Context Rollover dispatch", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("DR01 commits before dispatch and sends the prepared request once", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const branch = harness.sessionManager.getBranch();
		const checkpoint = createCheckpointEnvelopeFixture({
			checkpointId: "checkpoint-1",
			promptGeneration: 0,
			contextEpoch: 0,
			branch,
			coveredStartEntryId: sourceId,
			coveredEndEntryId: sourceId,
			summary: "The implementation is unfinished.",
			todoStateEntryId: null,
			todoStateFingerprint: fingerprintContextRolloverValue([]),
			requestConfigFingerprint: requestConfigFingerprint(harness),
			nextAction: "continue implementation",
		});
		harness.sessionManager.appendCustomEntry("context-rollover-checkpoint", checkpoint);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("continued")]);

		const ran = await (harness.session as unknown as RolloverInternals)._runContextRollover(
			"maintenance-1",
			{ triggerId: "trigger-1", cause: "budget_limit", phase: "mid_run", continuation: "required" },
			{
				outcome: "blocked",
				requestFingerprint: "source-request",
				budget: limitedBudget(),
				reason: "methods_exhausted",
				attempts: [],
			},
		);

		expect(ran).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);
		const authority = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "context_rollover" || entry.type === "context_rollover_dispatch");
		expect(authority.map((entry) => (entry.type === "context_rollover" ? "rollover" : entry.state))).toEqual([
			"rollover",
			"started",
			"finished",
		]);
		expect(harness.session.contextRolloverState).toMatchObject({
			contextEpoch: 1,
			rolloverCount: 1,
			dispatchState: "finished",
		});
		expect(JSON.stringify(harness.session.messages)).toContain("continued");
	});

	it("DR12 persists cancellation after commit but before dispatch starts", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-cancelled", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const queued = new PendingDeliveryStore(harness.sessionManager, {
			createDeliveryId: () => "delivery-cancelled",
		}).enqueue("steering", { role: "user", content: "cancelled steering", timestamp: 2 });
		harness.session.agent.steer(queued);
		const branch = harness.sessionManager.getBranch();
		harness.sessionManager.appendCustomEntry(
			"context-rollover-checkpoint",
			createCheckpointEnvelopeFixture({
				checkpointId: "checkpoint-cancelled",
				promptGeneration: 0,
				contextEpoch: 0,
				branch,
				coveredStartEntryId: sourceId,
				coveredEndEntryId: sourceId,
				summary: "The implementation is unfinished.",
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				requestConfigFingerprint: requestConfigFingerprint(harness),
				nextAction: "continue implementation",
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const abortController = new AbortController();
		const originalAppend = harness.sessionManager.appendContextRollover.bind(harness.sessionManager);
		harness.sessionManager.appendContextRollover = ((input) => {
			const entryId = originalAppend(input);
			abortController.abort();
			return entryId;
		}) as typeof harness.sessionManager.appendContextRollover;

		const ran = await (harness.session as unknown as RolloverInternals)._runContextRollover(
			"maintenance-cancelled",
			{
				triggerId: "trigger-cancelled",
				cause: "budget_limit",
				phase: "mid_run",
				continuation: "required",
				signal: abortController.signal,
			},
			{
				outcome: "blocked",
				requestFingerprint: "source-request",
				budget: limitedBudget(),
				reason: "methods_exhausted",
				attempts: [],
			},
		);

		expect(ran).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getContextRolloverState()).toMatchObject({ dispatchState: "cancelled" });
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "context_rollover_dispatch")).toEqual([
			expect.objectContaining({ state: "cancelled" }),
		]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(true);
		expect(new PendingDeliveryStore(harness.sessionManager).snapshot().items).toEqual([
			expect.objectContaining({ queueItemId: "delivery-cancelled" }),
		]);
	});

	it("does not dispatch a delivery cancelled after rollover commit", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-queue-cancelled", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const queued = new PendingDeliveryStore(harness.sessionManager, {
			createDeliveryId: () => "delivery-commit-cancelled",
		}).enqueue("steering", { role: "user", content: "must not dispatch", timestamp: 2 });
		harness.session.agent.steer(queued);
		const branch = harness.sessionManager.getBranch();
		harness.sessionManager.appendCustomEntry(
			"context-rollover-checkpoint",
			createCheckpointEnvelopeFixture({
				checkpointId: "checkpoint-commit-cancelled",
				promptGeneration: 0,
				contextEpoch: 0,
				branch,
				coveredStartEntryId: sourceId,
				coveredEndEntryId: sourceId,
				summary: "The implementation is unfinished.",
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				requestConfigFingerprint: requestConfigFingerprint(harness),
				nextAction: "continue implementation",
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const originalCommit = harness.session.commitContextRollover.bind(harness.session);
		harness.session.commitContextRollover = ((expected, input) => {
			const result = originalCommit(expected, input);
			harness.session.clearQueue();
			return result;
		}) as typeof harness.session.commitContextRollover;

		const ran = await (harness.session as unknown as RolloverInternals)._runContextRollover(
			"maintenance-commit-cancelled",
			{ triggerId: "trigger-commit-cancelled", cause: "budget_limit", phase: "mid_run", continuation: "required" },
			{
				outcome: "blocked",
				requestFingerprint: "source-request",
				budget: limitedBudget(),
				reason: "methods_exhausted",
				attempts: [],
			},
		);

		expect(ran).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(new PendingDeliveryStore(harness.sessionManager).snapshot().items).toEqual([]);
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			type: "context_rollover_dispatch",
			state: "cancelled",
		});
	});

	it("AC08 rolls back the rollover commit when persistence fails", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-append-failure", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const queued = new PendingDeliveryStore(harness.sessionManager, {
			createDeliveryId: () => "delivery-append-failure",
		}).enqueue("steering", { role: "user", content: "must remain pending", timestamp: 2 });
		harness.session.agent.steer(queued);
		const branch = harness.sessionManager.getBranch();
		harness.sessionManager.appendCustomEntry(
			"context-rollover-checkpoint",
			createCheckpointEnvelopeFixture({
				checkpointId: "checkpoint-append-failure",
				promptGeneration: 0,
				contextEpoch: 0,
				branch,
				coveredStartEntryId: sourceId,
				coveredEndEntryId: sourceId,
				summary: "The implementation is unfinished.",
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				requestConfigFingerprint: requestConfigFingerprint(harness),
				nextAction: "continue implementation",
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.sessionManager.appendContextRollover = ((input) => {
			void input;
			throw new Error("rollover persistence failed");
		}) as typeof harness.sessionManager.appendContextRollover;

		const ran = await (harness.session as unknown as RolloverInternals)._runContextRollover(
			"maintenance-append-failure",
			{ triggerId: "trigger-append-failure", cause: "budget_limit", phase: "mid_run", continuation: "required" },
			{
				outcome: "blocked",
				requestFingerprint: "source-request",
				budget: limitedBudget(),
				reason: "methods_exhausted",
				attempts: [],
			},
		);

		expect(ran).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		expect(new PendingDeliveryStore(harness.sessionManager).snapshot().items).toEqual([
			expect.objectContaining({ queueItemId: "delivery-append-failure" }),
		]);
	});

	it("DR02 releases the resume preparation when dispatch_started cannot be persisted", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "rollover-resume-write-failure", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const queued = new PendingDeliveryStore(harness.sessionManager, {
			createDeliveryId: () => "delivery-resume",
		}).enqueue("steering", { role: "user", content: "resume steering", timestamp: 2 });
		harness.session.agent.steer(queued);
		const bundle: ContextRolloverBundle = {
			version: 1,
			checkpointId: "checkpoint-resume",
			checkpointEntryId: "checkpoint-entry-resume",
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			note: {
				version: 1,
				objective: { text: "implement rollover", sourceEntryIds: [sourceId] },
				userConstraints: [],
				acceptanceCriteria: { status: "not_specified", items: [] },
				decisions: [],
				completedWork: [],
				currentState: { text: "unfinished", evidenceEntryIds: [sourceId] },
				failedAttempts: [],
				nextAction: { text: "continue", evidenceEntryIds: [] },
				historyRefs: [],
			},
			activeTodosAtCommit: [],
			todoStateEntryIdAtCommit: null,
			todoStateFingerprintAtCommit: "todos",
			activeEntryIds: [],
			historyAllowlist: [],
			sourceFingerprint: "source",
			progressBaselineFingerprint: "progress",
			taskNoteProjectionRevision: "notes",
		};
		const revisions = {
			sessionLeafId: harness.sessionManager.getLeafId(),
			sourceFingerprint: "source",
			todoStateEntryId: null,
			todoStateFingerprint: "todos",
			queueRevision: "queue",
			progressRevision: "progress",
			requestConfigFingerprint: "config",
		};
		const provisional: ContextRolloverEntry = {
			type: "context_rollover",
			id: "rollover-resume",
			parentId: revisions.sessionLeafId,
			timestamp: "2026-01-01T00:00:00.000Z",
			rolloverId: "rollover-resume",
			dispatchId: "dispatch-placeholder",
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			checkpointEntryId: bundle.checkpointEntryId,
			bundle,
			expectedRevisions: revisions,
			sourceTokens: 90,
			preparedTokens: 40,
			sourceRequestFingerprint: "source-request",
			preparedRequestFingerprint: "prepared-placeholder",
			preparationBaseFingerprint: "base-placeholder",
			reservedDeliveryIds: ["delivery-resume"],
			strongProgressCreditIds: [],
		};
		const candidateMessages = buildSessionContext(
			[...harness.sessionManager.getEntries(), provisional],
			provisional.id,
		).messages;
		harness.session.agent.state.messages = candidateMessages;
		const preparation = await harness.session.agent.prepareContinuation(candidateMessages);
		harness.session.agent.releasePreparedContinuation(preparation);
		const rolloverId = "rollover-resume";
		const dispatchId = createContextRolloverDispatchId(rolloverId, preparation.requestFingerprint);
		harness.sessionManager.appendContextRollover({
			rolloverId,
			dispatchId,
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			checkpointEntryId: bundle.checkpointEntryId,
			bundle,
			expectedRevisions: revisions,
			sourceTokens: 90,
			preparedTokens: preparation.budget.tokens,
			sourceRequestFingerprint: "source-request",
			preparedRequestFingerprint: preparation.requestFingerprint,
			preparationBaseFingerprint: preparation.baseContextFingerprint,
			reservedDeliveryIds: [...preparation.reservedQueueItemIds],
			strongProgressCreditIds: [],
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const originalAppend = harness.sessionManager.appendContextRolloverDispatch.bind(harness.sessionManager);
		harness.sessionManager.appendContextRolloverDispatch = ((input) => {
			if (input.state === "started") throw new Error("dispatch journal unavailable");
			return originalAppend(input);
		}) as typeof harness.sessionManager.appendContextRolloverDispatch;

		await (harness.session as unknown as RolloverInternals)._resumePreparedContextRollover();

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(new PendingDeliveryStore(harness.sessionManager).snapshot().items).toEqual([
			expect.objectContaining({ queueItemId: "delivery-resume" }),
		]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_rollover_dispatch")).toBe(
			false,
		);
	});

	it("DR05 blocks resume when the rebuilt preparation fingerprint changes", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-resume-mismatch", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const bundle: ContextRolloverBundle = {
			version: 1,
			checkpointId: "checkpoint-resume-mismatch",
			checkpointEntryId: "checkpoint-entry-resume-mismatch",
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			note: {
				version: 1,
				objective: { text: "implement rollover", sourceEntryIds: [sourceId] },
				userConstraints: [],
				acceptanceCriteria: { status: "not_specified", items: [] },
				decisions: [],
				completedWork: [],
				currentState: { text: "unfinished", evidenceEntryIds: [sourceId] },
				failedAttempts: [],
				nextAction: { text: "continue", evidenceEntryIds: [] },
				historyRefs: [],
			},
			activeTodosAtCommit: [],
			todoStateEntryIdAtCommit: null,
			todoStateFingerprintAtCommit: "todos",
			activeEntryIds: [],
			historyAllowlist: [],
			sourceFingerprint: "source",
			progressBaselineFingerprint: "progress",
			taskNoteProjectionRevision: "notes",
		};
		const rolloverId = "rollover-resume-mismatch";
		const preparedRequestFingerprint = "prepared-request";
		harness.sessionManager.appendContextRollover({
			rolloverId,
			dispatchId: createContextRolloverDispatchId(rolloverId, preparedRequestFingerprint),
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			checkpointEntryId: bundle.checkpointEntryId,
			bundle,
			expectedRevisions: {
				sessionLeafId: sourceId,
				sourceFingerprint: "source",
				todoStateEntryId: null,
				todoStateFingerprint: "todos",
				queueRevision: "queue",
				progressRevision: "progress",
				requestConfigFingerprint: "config",
			},
			sourceTokens: 9000,
			preparedTokens: 4500,
			sourceRequestFingerprint: "source-request",
			preparedRequestFingerprint,
			preparationBaseFingerprint: "intentionally-wrong-base",
			reservedDeliveryIds: [],
			strongProgressCreditIds: [],
		});

		await (harness.session as unknown as RolloverInternals)._resumePreparedContextRollover();

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			type: "context_rollover_dispatch",
			state: "blocked",
			reason: "dispatch_prepare_mismatch",
		});
	});

	it("AC07 retries one superseded assembly before blocking a second source change", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-superseded", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const branch = harness.sessionManager.getBranch();
		harness.sessionManager.appendCustomEntry(
			"context-rollover-checkpoint",
			createCheckpointEnvelopeFixture({
				checkpointId: "checkpoint-superseded",
				promptGeneration: 0,
				contextEpoch: 0,
				branch,
				coveredStartEntryId: sourceId,
				coveredEndEntryId: sourceId,
				summary: "The implementation is unfinished.",
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				requestConfigFingerprint: requestConfigFingerprint(harness),
				nextAction: "continue implementation",
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let preparationCalls = 0;
		const originalPrepare = harness.session.agent.prepareContinuation.bind(harness.session.agent);
		harness.session.agent.prepareContinuation = (async (...args) => {
			preparationCalls++;
			return await originalPrepare(...args);
		}) as typeof harness.session.agent.prepareContinuation;
		let commitCalls = 0;
		harness.session.commitContextRollover = ((..._args: Parameters<typeof harness.session.commitContextRollover>) => {
			commitCalls++;
			if (commitCalls === 1) {
				const queued = new PendingDeliveryStore(harness.sessionManager, {
					createDeliveryId: () => "delivery-after-supersede",
				}).enqueue("steering", { role: "user", content: "new source", timestamp: 2 });
				harness.session.agent.steer(queued);
			}
			return { status: "superseded" };
		}) as typeof harness.session.commitContextRollover;

		const ran = await (harness.session as unknown as RolloverInternals)._runContextRollover(
			"maintenance-superseded",
			{ triggerId: "trigger-superseded", cause: "budget_limit", phase: "mid_run", continuation: "required" },
			{
				outcome: "blocked",
				requestFingerprint: "source-request",
				budget: limitedBudget(),
				reason: "methods_exhausted",
				attempts: [],
			},
		);

		expect(ran).toBe(false);
		expect(preparationCalls).toBe(2);
		expect(commitCalls).toBe(2);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("coalesces only the same rollover source and rechecks a different source", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-single-flight", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		let executions = 0;
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const sessionWithInternals = harness.session as unknown as {
			_runContextRollover: (
				maintenanceId: string,
				trigger: { triggerId: string; cause: "budget_limit"; phase: "mid_run"; continuation: "required" },
				outcome: {
					outcome: "blocked";
					requestFingerprint: string;
					budget: ContextBudget;
					reason: "methods_exhausted";
					attempts: [];
				},
			) => Promise<boolean>;
		};
		const originalExecute = (
			harness.session as unknown as {
				_executeContextRollover: (...args: unknown[]) => Promise<boolean>;
			}
		)._executeContextRollover.bind(harness.session);
		(
			harness.session as unknown as { _executeContextRollover: (...args: unknown[]) => Promise<boolean> }
		)._executeContextRollover = async (...args) => {
			executions++;
			if (executions === 1) await firstBlocked;
			return await originalExecute(...args);
		};

		const call = (requestFingerprint: string) =>
			sessionWithInternals._runContextRollover(
				`maintenance-${requestFingerprint}`,
				{
					triggerId: `trigger-${requestFingerprint}`,
					cause: "budget_limit",
					phase: "mid_run",
					continuation: "required",
				},
				{
					outcome: "blocked",
					requestFingerprint,
					budget: limitedBudget(),
					reason: "methods_exhausted",
					attempts: [],
				},
			);
		const first = call("same-source");
		await Promise.resolve();
		const same = call("same-source");
		const different = call("different-source");
		releaseFirst!();
		await Promise.all([first, same, different]);

		expect(executions).toBe(2);
	});

	it("DR dispatch records a failed provider outcome as failed", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-failed", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const branch = harness.sessionManager.getBranch();
		harness.sessionManager.appendCustomEntry(
			"context-rollover-checkpoint",
			createCheckpointEnvelopeFixture({
				checkpointId: "checkpoint-failed",
				promptGeneration: 0,
				contextEpoch: 0,
				branch,
				coveredStartEntryId: sourceId,
				coveredEndEntryId: sourceId,
				summary: "The implementation is unfinished.",
				todoStateEntryId: null,
				todoStateFingerprint: fingerprintContextRolloverValue([]),
				requestConfigFingerprint: requestConfigFingerprint(harness),
				nextAction: "continue implementation",
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage("provider failed", { stopReason: "error", errorMessage: "provider exploded" }),
		]);

		const ran = await (harness.session as unknown as RolloverInternals)._runContextRollover(
			"maintenance-failed",
			{ triggerId: "trigger-failed", cause: "budget_limit", phase: "mid_run", continuation: "required" },
			{
				outcome: "blocked",
				requestFingerprint: "source-request",
				budget: limitedBudget(),
				reason: "methods_exhausted",
				attempts: [],
			},
		);

		expect(ran).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "context_rollover_dispatch")
				.at(-1),
		).toMatchObject({ state: "finished", outcome: "failed" });
	});

	it("DR10 resumes target-epoch maintenance after a finished context limit", async () => {
		const harness = await createHarness({
			models: [{ id: "rollover-resume-limit", contextWindow: 10000, maxTokens: 1000 }],
			settings: { compaction: { reserveTokens: 1000 } },
		});
		harnesses.push(harness);
		const sourceId = harness.sessionManager.appendMessage({
			role: "user",
			content: "implement rollover",
			timestamp: 1,
		});
		const bundle: ContextRolloverBundle = {
			version: 1,
			checkpointId: "checkpoint-resume-limit",
			checkpointEntryId: "checkpoint-entry-resume-limit",
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			note: {
				version: 1,
				objective: { text: "implement rollover", sourceEntryIds: [sourceId] },
				userConstraints: [],
				acceptanceCriteria: { status: "not_specified", items: [] },
				decisions: [],
				completedWork: [],
				currentState: { text: "unfinished", evidenceEntryIds: [sourceId] },
				failedAttempts: [],
				nextAction: { text: "continue", evidenceEntryIds: [] },
				historyRefs: [],
			},
			activeTodosAtCommit: [],
			todoStateEntryIdAtCommit: null,
			todoStateFingerprintAtCommit: "todos",
			activeEntryIds: [],
			historyAllowlist: [],
			sourceFingerprint: "source",
			progressBaselineFingerprint: "progress",
			taskNoteProjectionRevision: "notes",
		};
		harness.sessionManager.appendContextRollover({
			rolloverId: "rollover-resume-limit",
			dispatchId: "dispatch-resume-limit",
			promptGeneration: 0,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			checkpointEntryId: bundle.checkpointEntryId,
			bundle,
			expectedRevisions: {
				sessionLeafId: sourceId,
				sourceFingerprint: "source",
				todoStateEntryId: null,
				todoStateFingerprint: "todos",
				queueRevision: "queue",
				progressRevision: "progress",
				requestConfigFingerprint: "config",
			},
			sourceTokens: 9000,
			preparedTokens: 4500,
			sourceRequestFingerprint: "source-request",
			preparedRequestFingerprint: "prepared-request",
			preparationBaseFingerprint: "base",
			reservedDeliveryIds: [],
			strongProgressCreditIds: [],
		});
		harness.sessionManager.appendContextRolloverDispatch({
			dispatchId: "dispatch-resume-limit",
			rolloverId: "rollover-resume-limit",
			state: "finished",
			requestFingerprint: "prepared-request",
			outcome: "context_limit",
		});

		const internals = harness.session as unknown as RolloverInternals;
		const maintenance = vi.spyOn(internals, "_runContextMaintenance").mockResolvedValue("stop");
		await internals._resumePreparedContextRollover();

		expect(maintenance).toHaveBeenCalledTimes(1);
		expect(maintenance).toHaveBeenCalledWith(
			expect.objectContaining({ cause: "budget_limit", phase: "mid_run", continuation: "required" }),
		);
		expect(harness.session.contextRolloverState).toMatchObject({ contextEpoch: 1, dispatchState: "finished" });
	});
});
