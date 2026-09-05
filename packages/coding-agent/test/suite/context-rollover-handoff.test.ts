import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPrefixCheckpointFromBoundary } from "../../src/core/compaction/checkpoint.ts";
import {
	assembleContextRolloverBundle,
	type ContextRolloverNote,
	collectCompleteToolTransactions,
	fingerprintContextRolloverValue,
	selectLatestContextRolloverCheckpoint,
	validateContextRolloverNote,
	validateFinalHandoff,
} from "../../src/core/context-rollover.ts";
import type { CustomEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { createTaskNoteBatchId, createTaskScopeId, type TaskNoteBatch } from "../../src/core/task-note-projection.ts";

function entry(value: Record<string, unknown>, parentId: string | null): SessionEntry {
	return { ...value, parentId, timestamp: "2026-01-01T00:00:00.000Z" } as unknown as SessionEntry;
}

const note = (objectiveId: string): ContextRolloverNote => ({
	version: 1 as const,
	objective: { text: "implement rollover", sourceEntryIds: [objectiveId] },
	userConstraints: [],
	acceptanceCriteria: { status: "not_specified", items: [] },
	decisions: [],
	completedWork: [],
	currentState: { text: "tests are red", evidenceEntryIds: [objectiveId] },
	failedAttempts: [],
	nextAction: { text: "make tests pass", evidenceEntryIds: [] },
	historyRefs: [],
});

describe("Context Rollover handoff", () => {
	it("HB07 keeps an assistant with multiple tool calls and all results atomic", () => {
		const userEntry = entry(
			{ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } },
			null,
		);
		const assistant = entry(
			{
				type: "message",
				id: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
						{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
					],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				} satisfies AssistantMessage,
			},
			"user",
		);
		const result = (id: string, callId: string, parentId: string) =>
			entry(
				{
					type: "message",
					id,
					message: {
						role: "toolResult",
						toolCallId: callId,
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 3,
					} satisfies ToolResultMessage,
				},
				parentId,
			);
		const first = result("result-1", "call-1", "assistant");
		const second = result("result-2", "call-2", "result-1");

		expect(collectCompleteToolTransactions([userEntry, assistant, first, second])).toEqual([
			["user"],
			["assistant", "result-1", "result-2"],
		]);
		expect(() => collectCompleteToolTransactions([userEntry, assistant, first])).toThrow(
			"tool_transaction_incomplete",
		);
	});

	it("HB08 rejects a checkpoint that splits a tool transaction", () => {
		const branch = toolBranch();
		const checkpoint = checkpointEntry(branch, ["user", "assistant", "result-1"]);
		expect(selectLatestContextRolloverCheckpoint([...branch, checkpoint], 1, 0)).toBeUndefined();
	});

	it("NC02 rejects the removed bare-checkpoint persistence shape", () => {
		const user = entry({ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } }, null);
		const bare = entry(
			{
				type: "custom",
				id: "bare-checkpoint",
				customType: "context-rollover-checkpoint",
				data: checkpointData([user]),
			},
			"user",
		);
		expect(selectLatestContextRolloverCheckpoint([user, bare], 1, 0)).toBeUndefined();
	});

	it("HB06 assembles a disjoint ordered suffix and exact history allowlist", () => {
		const first = entry(
			{ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } satisfies UserMessage },
			null,
		);
		const covered = entry(
			{
				type: "message",
				id: "covered",
				message: { role: "user", content: "old", timestamp: 2 } satisfies UserMessage,
			},
			"user",
		);
		const suffix = entry(
			{
				type: "message",
				id: "suffix",
				message: { role: "user", content: "new", timestamp: 3 } satisfies UserMessage,
			},
			"covered",
		);
		const withHistory = { ...note("user"), historyRefs: [{ entryId: "covered", purpose: "detail" }] };
		const checkpoint = checkpointData([first, covered], withHistory);

		const bundle = assembleContextRolloverBundle({
			checkpoint,
			checkpointEntryId: "checkpoint-entry",
			contextEntries: [first, covered, suffix],
			taskNoteProjection: emptyProjection(),
			targetContextEpoch: 1,
			activeTodos: [],
			todoStateEntryId: null,
			todoStateFingerprint: "todo-0",
			progressBaselineFingerprint: "progress-0",
		});

		expect(bundle.activeEntryIds).toEqual(["suffix"]);
		expect(bundle.historyAllowlist).toEqual([{ entryId: "user" }, { entryId: "covered" }]);
	});

	it("HB18 requires objective and constraints to retain real user provenance", () => {
		const assistant = entry(
			{
				type: "message",
				id: "assistant",
				message: {
					role: "assistant",
					content: [],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				} satisfies AssistantMessage,
			},
			null,
		);
		expect(() => validateContextRolloverNote(note("assistant"), [assistant])).toThrow("invalid_evidence");
	});

	it("NH03 accepts criteria only from a user source or persisted Task contract", () => {
		const user = entry(
			{ type: "message", id: "user", message: { role: "user", content: "Tests must pass.", timestamp: 1 } },
			null,
		);
		const specified: ContextRolloverNote = {
			...note("user"),
			acceptanceCriteria: {
				status: "specified",
				items: [{ text: "Tests must pass.", sourceEntryIds: ["user"], taskContractIds: [] }],
			},
		};
		expect(() => validateContextRolloverNote(specified, [user])).not.toThrow();
		expect(() =>
			validateContextRolloverNote(
				{
					...specified,
					acceptanceCriteria: {
						status: "specified",
						items: [{ text: "Tests must pass.", sourceEntryIds: [], taskContractIds: [] }],
					},
				},
				[user],
			),
		).toThrow("invalid_evidence");
	});

	it("HB18 carries prior Handoff provenance into the next epoch without widening it", () => {
		const user = entry(
			{
				type: "message",
				id: "original-user",
				message: { role: "user", content: "finish the feature", timestamp: 1 },
			},
			null,
		);
		const priorBundle = {
			version: 1 as const,
			checkpointId: "prior-checkpoint",
			checkpointEntryId: "prior-checkpoint-entry",
			promptGeneration: 1,
			sourceContextEpoch: 0,
			targetContextEpoch: 1,
			note: note("original-user"),
			activeTodosAtCommit: [],
			todoStateEntryIdAtCommit: null,
			todoStateFingerprintAtCommit: "todo-0",
			activeEntryIds: [],
			historyAllowlist: [],
			sourceFingerprint: "source-0",
			progressBaselineFingerprint: "progress-0",
			taskNoteProjectionRevision: "notes-0",
		};
		const priorRollover = entry(
			{
				type: "context_rollover",
				id: "prior-rollover",
				rolloverId: "prior-rollover",
				dispatchId: "prior-dispatch",
				promptGeneration: 1,
				sourceContextEpoch: 0,
				targetContextEpoch: 1,
				checkpointEntryId: "prior-checkpoint-entry",
				bundle: priorBundle,
				expectedRevisions: {
					sessionLeafId: "original-user",
					sourceFingerprint: "source-0",
					todoStateEntryId: null,
					todoStateFingerprint: "todo-0",
					queueRevision: "queue-0",
					progressRevision: "progress-0",
					requestConfigFingerprint: "config-0",
				},
				sourceTokens: 90,
				preparedTokens: 30,
				sourceRequestFingerprint: "request-0",
				preparedRequestFingerprint: "request-1",
				preparationBaseFingerprint: "base-1",
				reservedDeliveryIds: [],
				strongProgressCreditIds: [],
			},
			"original-user",
		);
		const current = entry(
			{
				type: "message",
				id: "current-user",
				message: { role: "user", content: "continue from the handoff", timestamp: 2 },
			},
			"prior-rollover",
		);
		const currentNote = note("original-user");
		const checkpoint = checkpointEntry([current], ["current-user"]);
		const envelope = checkpoint.data as { checkpoint: Record<string, unknown> };
		checkpoint.data = {
			...envelope,
			checkpoint: {
				...envelope.checkpoint,
				contextEpoch: 1,
				compactionPrefix: createPrefixCheckpointFromBoundary(
					[user, priorRollover, current],
					current.id,
					JSON.stringify(currentNote),
				),
				note: currentNote,
			},
		};
		const selected = selectLatestContextRolloverCheckpoint([user, priorRollover, current, checkpoint], 1, 1);

		expect(selected?.entryId).toBe("checkpoint-entry");
	});

	it("CP07 rejects malformed note shapes with invalid_output", () => {
		const user = entry({ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } }, null);
		const malformed = { ...note("user"), currentState: undefined } as unknown as ContextRolloverNote;
		expect(() => validateContextRolloverNote(malformed, [user])).toThrow("invalid_output");
	});

	it("CP07 rejects non-string decision reasons with invalid_output", () => {
		const user = entry({ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } }, null);
		const malformed = {
			...note("user"),
			decisions: [{ text: "use the focused test", reason: 42, sourceEntryIds: ["user"] }],
		} as unknown as ContextRolloverNote;
		expect(() => validateContextRolloverNote(malformed, [user])).toThrow("invalid_output");
	});

	it("CP10 rejects failed progress as completed-work evidence", () => {
		const user = entry({ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } }, null);
		const failedProgress = entry(
			{
				type: "context_progress",
				id: "progress",
				evidenceId: "progress",
				evidenceKind: "non_read_effect",
				targetFingerprint: "target",
				resultFingerprint: "result",
				outcome: "failed",
			},
			"user",
		);
		const malformed = {
			...note("user"),
			completedWork: [{ text: "completed", todoIds: [], evidenceEntryIds: ["progress"] }],
		};
		expect(() => validateContextRolloverNote(malformed, [user, failedProgress])).toThrow("invalid_evidence");
	});

	it("CP16 rejects secrets in every note text field", () => {
		const user = entry({ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } }, null);
		const unsafe = {
			...note("user"),
			decisions: [{ text: "use token", reason: "api_key=secret-value-1234", sourceEntryIds: ["user"] }],
		};
		expect(() => validateContextRolloverNote(unsafe, [user])).toThrow("unsafe_content");
	});

	it("EV04 downgrades stale state in the final Handoff and rejects a current-success claim", () => {
		const user = entry(
			{ type: "message", id: "user", message: { role: "user", content: "verify auth", timestamp: 1 } },
			null,
		);
		const progress = entry(
			{
				type: "context_progress",
				id: "verification",
				evidenceId: "verification",
				evidenceKind: "verification",
				targetFingerprint: "auth",
				subjectId: "auth",
				inputFingerprint: "revision-1",
				resultFingerprint: "pass",
				outcome: "succeeded",
			},
			"user",
		);
		const projection = {
			scope: { taskScopeId: createTaskScopeId("user"), promptGeneration: 1 },
			revision: "notes-stale",
			items: [
				{
					eventId: "note-state",
					kind: "state" as const,
					key: "auth.tests",
					text: "Auth tests pass.",
					sourceRefs: [{ entryId: "user" }],
					evidence: [
						{
							reference: { entryId: "verification" },
							evidenceKind: "process_result" as const,
							subjectId: "auth",
							inputFingerprint: "revision-1",
							resultFingerprint: "pass",
							observedAtEntryId: "verification",
							outcome: "succeeded" as const,
						},
					],
					freshness: "stale" as const,
				},
			],
		};
		const bundle = assembleContextRolloverBundle({
			checkpoint: checkpointData([user]),
			checkpointEntryId: "checkpoint-entry",
			contextEntries: [user, progress],
			taskNoteProjection: projection,
			targetContextEpoch: 1,
			activeTodos: [],
			todoStateEntryId: null,
			todoStateFingerprint: "todo-0",
			progressBaselineFingerprint: "progress-0",
		});
		expect(bundle.note.currentState.text).toContain("revalidation is required");
		expect(() =>
			validateFinalHandoff({ bundle, branch: [user, progress], projection, activeTodos: [], contextWindow: 10000 }),
		).not.toThrow();
		bundle.note.currentState.text = "Auth tests pass.";
		expect(() =>
			validateFinalHandoff({ bundle, branch: [user, progress], projection, activeTodos: [], contextWindow: 10000 }),
		).toThrow("handoff_invalid");
	});
});

function checkpointData(branch: SessionEntry[], value = note("user")) {
	return {
		version: 1 as const,
		checkpointId: "checkpoint-1",
		promptGeneration: 1,
		contextEpoch: 0,
		coveredStartEntryId: branch[0].id,
		coveredEndEntryId: branch.at(-1)?.id ?? branch[0].id,
		coveredEntryIds: branch.map((value) => value.id),
		sourcePrefixFingerprint: fingerprintContextRolloverValue(branch),
		todoStateEntryId: null,
		todoStateFingerprint: "todo-0",
		requestConfigFingerprint: "config-0",
		compactionPrefix: createPrefixCheckpointFromBoundary(
			branch,
			branch.at(-1)?.id ?? branch[0].id,
			JSON.stringify(value),
		),
		note: value,
	};
}

function checkpointEntry(branch: SessionEntry[], coveredEntryIds: string[]): CustomEntry {
	const checkpoint = {
		...checkpointData(branch.filter((value) => coveredEntryIds.includes(value.id))),
		coveredStartEntryId: coveredEntryIds[0],
		coveredEndEntryId: coveredEntryIds.at(-1),
		coveredEntryIds,
	};
	const events: TaskNoteBatch["events"] = [];
	return entry(
		{
			type: "custom",
			id: "checkpoint-entry",
			customType: "context-rollover-checkpoint",
			data: {
				version: 1,
				checkpoint,
				taskNoteBatch: {
					version: 1,
					batchId: createTaskNoteBatchId(checkpoint.checkpointId, events),
					events,
				},
			},
		},
		branch.at(-1)?.id ?? null,
	) as CustomEntry;
}

function emptyProjection() {
	return {
		scope: { taskScopeId: "scope", promptGeneration: 1 },
		revision: "notes-0",
		items: [],
	};
}

function toolBranch(): SessionEntry[] {
	const user = entry({ type: "message", id: "user", message: { role: "user", content: "go", timestamp: 1 } }, null);
	const assistant = entry(
		{
			type: "message",
			id: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
					{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			} as AssistantMessage,
		},
		"user",
	);
	const result = (id: string, callId: string, parentId: string) =>
		entry(
			{
				type: "message",
				id,
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [],
					isError: false,
					timestamp: 3,
				} as ToolResultMessage,
			},
			parentId,
		);
	return [user, assistant, result("result-1", "call-1", "assistant"), result("result-2", "call-2", "result-1")];
}
