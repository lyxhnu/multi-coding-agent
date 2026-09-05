import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ContextRolloverBundle, ContextRolloverRevisions } from "../../src/core/context-rollover.ts";
import { PendingDeliveryStore } from "../../src/core/pending-delivery.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const user = (content: string, timestamp: number): UserMessage => ({ role: "user", content, timestamp });

function bundle(objectiveSourceId: string, activeEntryIds: string[]): ContextRolloverBundle {
	return {
		version: 1,
		checkpointId: "checkpoint-1",
		checkpointEntryId: "checkpoint-entry-1",
		promptGeneration: 1,
		sourceContextEpoch: 0,
		targetContextEpoch: 1,
		note: {
			version: 1,
			objective: { text: "finish the feature", sourceEntryIds: [objectiveSourceId] },
			userConstraints: [],
			acceptanceCriteria: { status: "not_specified", items: [] },
			decisions: [],
			completedWork: [],
			currentState: { text: "implementation started", evidenceEntryIds: [objectiveSourceId] },
			failedAttempts: [],
			nextAction: { text: "run the focused test", evidenceEntryIds: [] },
			historyRefs: [],
		},
		activeTodosAtCommit: [],
		todoStateEntryIdAtCommit: null,
		todoStateFingerprintAtCommit: "todos-0",
		activeEntryIds,
		historyAllowlist: [],
		sourceFingerprint: "source-1",
		progressBaselineFingerprint: "progress-0",
		taskNoteProjectionRevision: "notes-0",
	};
}

function revisions(leafId: string | null): ContextRolloverRevisions {
	return {
		sessionLeafId: leafId,
		sourceFingerprint: "source-1",
		todoStateEntryId: null,
		todoStateFingerprint: "todos-0",
		queueRevision: "queue-1",
		progressRevision: "progress-0",
		requestConfigFingerprint: "request-config-1",
	};
}

describe("Context Rollover session persistence", () => {
	it("S3 rebuilds operation quotas from started ledger entries", () => {
		const manager = SessionManager.inMemory("C:/workspace");
		manager.appendContextOperation({
			operationId: "operation-1",
			operationKind: "soft_compaction",
			state: "started",
			promptGeneration: 2,
			contextEpoch: 3,
			sourceFingerprint: "source-1",
		});
		manager.appendContextOperation({
			operationId: "operation-1",
			operationKind: "soft_compaction",
			state: "finished",
			promptGeneration: 2,
			contextEpoch: 3,
			sourceFingerprint: "source-1",
			outcome: "failed",
		});

		expect(manager.getContextOperationUsage(2, 3)).toEqual({
			checkpoint: 0,
			softCompaction: 1,
			overflowRetry: 0,
		});
	});

	it("DQ03 treats dispatch_started as the atomic delivery receipt", () => {
		const manager = SessionManager.inMemory("C:/workspace");
		const store = new PendingDeliveryStore(manager, { createDeliveryId: () => "delivery-1" });
		store.enqueue("steering", user("queued once", 2));
		manager.appendContextRolloverDispatch({
			dispatchId: "dispatch-1",
			rolloverId: "rollover-1",
			state: "started",
			requestFingerprint: "request-1",
			reservedDeliveryIds: ["delivery-1"],
		});

		expect(store.snapshot().items).toEqual([]);
		expect(manager.buildSessionContext().messages).toEqual([user("queued once", 2)]);
	});

	it("S3 rebuilds only the latest rollover epoch with a fresh Todo projection", () => {
		const manager = SessionManager.inMemory("C:/workspace");
		const objectiveId = manager.appendMessage(user("finish the feature", 1));
		const suffixId = manager.appendMessage(user("uncovered suffix", 2));
		manager.appendCustomEntry("todo-state", [
			{ id: "todo-1", content: "old todo", priority: "medium", status: "pending" },
		]);
		manager.appendContextRollover({
			rolloverId: "rollover-1",
			dispatchId: "dispatch-1",
			promptGeneration: 1,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			checkpointEntryId: "checkpoint-entry-1",
			bundle: bundle(objectiveId, [suffixId]),
			expectedRevisions: revisions(manager.getLeafId()),
			sourceTokens: 90,
			preparedTokens: 40,
			sourceRequestFingerprint: "source-request",
			preparedRequestFingerprint: "prepared-request",
			preparationBaseFingerprint: "base-request",
			reservedDeliveryIds: [],
			strongProgressCreditIds: [],
		});
		manager.appendCustomEntry("todo-state", [
			{ id: "todo-1", content: "new todo", priority: "high", status: "in_progress" },
		]);
		manager.appendMessage(user("after rollover", 3));

		const context = manager.buildSessionContext().messages;
		expect(context).toHaveLength(4);
		expect(context[0]).toMatchObject({ role: "custom", customType: "context-rollover" });
		expect(context[1]).toEqual(user("uncovered suffix", 2));
		expect(context[2]).toMatchObject({ role: "custom", customType: "todo-state-projection" });
		expect(JSON.stringify(context[2])).toContain("new todo");
		expect(JSON.stringify(context[2])).not.toContain("old todo");
		expect(context[3]).toEqual(user("after rollover", 3));
		expect(JSON.stringify(context)).not.toContain('"content":"finish the feature"');
	});

	it("S3 fail-closes a started dispatch without a terminal entry", () => {
		const manager = SessionManager.inMemory("C:/workspace");
		manager.appendContextRolloverDispatch({
			dispatchId: "dispatch-1",
			rolloverId: "rollover-1",
			state: "started",
			requestFingerprint: "request-1",
			reservedDeliveryIds: [],
		});

		expect(manager.getContextRolloverState()).toEqual({
			contextEpoch: 0,
			rolloverCount: 0,
			dispatchState: "outcome_unknown",
			dispatchId: "dispatch-1",
			rolloverId: "rollover-1",
		});
	});
});
