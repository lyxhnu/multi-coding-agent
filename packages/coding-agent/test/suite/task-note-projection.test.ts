import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createContextRolloverCheckpointEnvelope,
	fingerprintContextRolloverValue,
} from "../../src/core/context-rollover.ts";
import { classifyToolEffect, decideToolPermission } from "../../src/core/permissions/policy.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	acceptTaskNoteCandidate,
	buildTaskNoteProjection,
	buildTaskNoteProjectionFromBranch,
	createTaskNoteEventId,
	createTaskNoteFreshnessResolver,
	createTaskScopeId,
	fingerprintTaskNoteWorkspaceContent,
	resolveTaskNoteScope,
	type TaskNoteCandidate,
	type TaskNoteEvent,
	type TaskNoteScope,
} from "../../src/core/task-note-projection.ts";
import { type ContextNoteToolInput, createContextNoteToolDefinition } from "../../src/core/tools/context-note.ts";
import { createHarness } from "./harness.ts";

const scope: TaskNoteScope = {
	taskScopeId: "scope-1",
	promptGeneration: 2,
};

function event(overrides: Partial<TaskNoteEvent> = {}): TaskNoteEvent {
	const base: TaskNoteEvent = {
		version: 1,
		eventId: "",
		operation: "upsert",
		scope,
		createdInContextEpoch: 3,
		kind: "next_action",
		key: "implementation.next",
		text: "Projection is not implemented.",
		sourceRefs: [{ entryId: "user-1" }],
		evidence: [],
		source: { type: "model_tool", toolCallId: "call-1" },
	};
	const value = { ...base, ...overrides };
	const candidate: TaskNoteCandidate = {
		operation: "upsert",
		kind: value.kind,
		key: value.key,
		text: value.text ?? "",
		sourceRefs: value.sourceRefs,
		evidenceRefs: value.evidence.map((stamp) => stamp.reference),
		...(value.supersedesEventId === undefined ? {} : { supersedesEventId: value.supersedesEventId }),
	};
	return { ...value, eventId: createTaskNoteEventId(value.scope, value.source, candidate) };
}

describe("TaskNoteProjection", () => {
	it("keeps a note active across context epochs and applies explicit supersession", () => {
		const original = event();
		const replacement = event({
			createdInContextEpoch: 4,
			text: "Projection is implemented.",
			supersedesEventId: original.eventId,
		});

		const projection = buildTaskNoteProjection({ events: [original, replacement], scope });

		expect(projection.status).toBe("valid");
		if (projection.status !== "valid") throw new Error("Expected a valid projection");
		expect(projection.snapshot.items).toEqual([
			expect.objectContaining({ eventId: replacement.eventId, text: "Projection is implemented." }),
		]);
	});

	it("accepts a user-sourced constraint and rejects assistant-only authority", () => {
		const user = {
			type: "message" as const,
			id: "user-1",
			parentId: null,
			timestamp: "2026-09-04T00:00:00.000Z",
			message: { role: "user" as const, content: "Do not preserve backward compatibility.", timestamp: 1 },
		};
		const assistant = {
			type: "message" as const,
			id: "assistant-1",
			parentId: user.id,
			timestamp: "2026-09-04T00:00:01.000Z",
			message: {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "Keep compatibility." }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop" as const,
				timestamp: 2,
			},
		};
		const emptyProjection = buildTaskNoteProjection({ events: [], scope });
		if (emptyProjection.status !== "valid") throw new Error("Expected a valid projection");
		const base = {
			operation: "upsert" as const,
			kind: "constraint" as const,
			key: "compatibility",
			text: "Do not preserve backward compatibility.",
			evidenceRefs: [],
		};
		const context = {
			scope,
			contextEpoch: 4,
			source: { type: "model_tool" as const, toolCallId: "call-2" },
			branch: [user, assistant],
			projection: emptyProjection.snapshot,
			eventCount: 0,
		};

		expect(acceptTaskNoteCandidate({ ...base, sourceRefs: [{ entryId: user.id }] }, context).status).toBe("accepted");
		expect(acceptTaskNoteCandidate({ ...base, sourceRefs: [{ entryId: assistant.id }] }, context)).toEqual({
			status: "rejected",
			reason: "invalid_reference",
		});
	});

	it("persists a context_note as session metadata without echoing its text", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("context-prompt-generation", { promptGeneration: 1, contextEpoch: 0 });
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "Never preserve backward compatibility.",
			timestamp: 1,
		});
		const traceEvents: unknown[] = [];
		const tool = createContextNoteToolDefinition({
			sessionManager,
			getPromptGeneration: () => 1,
			getContextEpoch: () => 3,
			onTrace: (event) => traceEvents.push(event),
		});

		const result = await tool.execute(
			"call-1",
			{
				operation: "upsert",
				kind: "constraint",
				key: "compatibility",
				text: "Never preserve backward compatibility.",
				sourceRefs: [{ entryId: userEntryId }],
				evidenceRefs: [],
			},
			undefined,
			undefined,
			{} as never,
		);

		const entry = sessionManager.getBranch().at(-1);
		expect(entry).toMatchObject({
			type: "custom",
			customType: "task-note-event",
			data: { createdInContextEpoch: 3, scope: { promptGeneration: 1 } },
		});
		expect(result.content[0]).toEqual({ type: "text", text: "Task note upsert: constraint/compatibility" });
		expect(JSON.stringify(result)).not.toContain("Never preserve backward compatibility.");
		expect(traceEvents).toEqual([
			expect.objectContaining({
				type: "context/task_note",
				data: expect.objectContaining({ outcome: "accepted", promptGeneration: 1, contextEpoch: 3 }),
			}),
		]);
		expect(JSON.stringify(traceEvents)).not.toContain("Never preserve backward compatibility.");
	});

	it("accepts checkpoint candidates into the same atomic envelope", () => {
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({ role: "user", content: "Keep the API small.", timestamp: 1 });
		const branch = sessionManager.getBranch();
		const checkpointScope = { taskScopeId: createTaskScopeId(userEntryId), promptGeneration: 0 };
		const projection = buildTaskNoteProjection({ events: [], scope: checkpointScope });
		if (projection.status !== "valid") throw new Error("Expected a valid projection");

		const envelope = createContextRolloverCheckpointEnvelope({
			checkpointId: "checkpoint-1",
			promptGeneration: 0,
			contextEpoch: 2,
			branch,
			coveredStartEntryId: userEntryId,
			coveredEndEntryId: userEntryId,
			output: {
				checkpoint: {
					version: 1,
					objective: { text: "Keep the API small.", sourceEntryIds: [userEntryId] },
					userConstraints: [],
					acceptanceCriteria: { status: "not_specified", items: [] },
					decisions: [],
					completedWork: [],
					currentState: { text: "Design is pending.", evidenceEntryIds: [userEntryId] },
					failedAttempts: [],
					nextAction: { text: "Implement the projection.", evidenceEntryIds: [] },
					historyRefs: [],
				},
				noteUpdateCandidates: [
					{
						operation: "upsert",
						kind: "constraint",
						key: "api.surface",
						text: "Keep the API small.",
						sourceRefs: [{ entryId: userEntryId }],
						evidenceRefs: [],
					},
				],
			},
			taskNoteScope: checkpointScope,
			taskNoteProjection: projection.snapshot,
			taskNoteEvents: [],
			todoStateEntryId: null,
			todoStateFingerprint: fingerprintContextRolloverValue([]),
			requestConfigFingerprint: "config",
		});

		expect(envelope.taskNoteBatch.events).toHaveLength(1);
		expect(envelope.taskNoteBatch.events[0]).toMatchObject({
			createdInContextEpoch: 2,
			source: { type: "checkpoint", checkpointId: "checkpoint-1", candidateIndex: 0 },
		});
	});

	it("marks evidence stale only when the same subject input changes", () => {
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({ role: "user", content: "Verify auth.", timestamp: 1 });
		sessionManager.appendContextProgress({
			evidenceId: "effect-1",
			evidenceKind: "non_read_effect",
			targetFingerprint: "auth-target",
			subjectId: "auth-target",
			resultFingerprint: "auth-revision-1",
			outcome: "succeeded",
		});
		const verificationId = sessionManager.appendContextProgress({
			evidenceId: "verification-1",
			evidenceKind: "verification",
			targetFingerprint: "auth-target",
			subjectId: "auth-target",
			inputFingerprint: "auth-revision-1",
			resultFingerprint: "tests-pass",
			outcome: "succeeded",
		});
		const branch = sessionManager.getBranch();
		const empty = buildTaskNoteProjection({ events: [], scope });
		if (empty.status !== "valid") throw new Error("Expected a valid projection");
		const accepted = acceptTaskNoteCandidate(
			{
				operation: "upsert",
				kind: "state",
				key: "auth.tests",
				text: "Auth tests pass.",
				sourceRefs: [{ entryId: userEntryId }],
				evidenceRefs: [{ entryId: verificationId }],
			},
			{
				scope,
				contextEpoch: 1,
				source: { type: "model_tool", toolCallId: "call-state" },
				branch,
				projection: empty.snapshot,
				eventCount: 0,
			},
		);
		if (accepted.status !== "accepted") throw new Error("Expected an accepted note");
		sessionManager.appendContextProgress({
			evidenceId: "unrelated-effect",
			evidenceKind: "non_read_effect",
			targetFingerprint: "docs-target",
			subjectId: "docs-target",
			resultFingerprint: "docs-revision-2",
			outcome: "succeeded",
		});
		let currentBranch = sessionManager.getBranch();
		let projection = buildTaskNoteProjection({
			events: [accepted.event],
			scope,
			resolveFreshness: createTaskNoteFreshnessResolver(currentBranch),
		});
		expect(projection.status === "valid" ? projection.snapshot.items[0].freshness : undefined).toBe("fresh");
		sessionManager.appendContextProgress({
			evidenceId: "effect-2",
			evidenceKind: "non_read_effect",
			targetFingerprint: "auth-target",
			subjectId: "auth-target",
			resultFingerprint: "auth-revision-2",
			outcome: "succeeded",
		});
		currentBranch = sessionManager.getBranch();
		projection = buildTaskNoteProjection({
			events: [accepted.event],
			scope,
			resolveFreshness: createTaskNoteFreshnessResolver(currentBranch),
		});
		expect(projection.status === "valid" ? projection.snapshot.items[0].freshness : undefined).toBe("stale");
	});

	it("registers context_note by default as a Plan Mode session write", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).toContain("context_note");
			expect(classifyToolEffect("context_note")).toBe("session");
			expect(
				decideToolPermission({ toolName: "context_note", args: {}, mode: "plan", cwd: process.cwd() }).decision,
			).toBe("allow");
		} finally {
			await harness.cleanup();
		}
	});

	it("exposes persisted entry IDs to the model without persisting the reference catalog", async () => {
		const harness = await createHarness();
		try {
			let providerMessages = "";
			harness.session.agent.streamFunction = (model, context) => {
				providerMessages = JSON.stringify(context.messages);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						...fauxAssistantMessage("done"),
						api: model.api,
						provider: model.provider,
						model: model.id,
					};
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			};

			await harness.session.prompt("Keep the API small.");
			const branch = harness.sessionManager.getBranch();
			const userEntry = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (userEntry === undefined) throw new Error("Expected a persisted user entry");

			expect(providerMessages).toContain("Task Note reference catalog");
			expect(providerMessages).toContain(userEntry.id);
			expect(
				branch.some(
					(entry) => entry.type === "custom_message" && entry.customType === "task-note-reference-catalog",
				),
			).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("detects an out-of-process workspace change from the stamped subject", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-task-note-"));
		const path = join(directory, "auth.ts");
		try {
			writeFileSync(path, "export const enabled = false;\n");
			const stamp = {
				reference: { entryId: "verification" },
				evidenceKind: "process_result" as const,
				subjectId: `workspace-file:${path}`,
				inputFingerprint: fingerprintTaskNoteWorkspaceContent("export const enabled = false;\n"),
				resultFingerprint: "pass",
				observedAtEntryId: "verification",
				outcome: "succeeded" as const,
			};
			expect(createTaskNoteFreshnessResolver([])(stamp)).toBe("fresh");
			writeFileSync(path, "export const enabled = true;\n");
			expect(createTaskNoteFreshnessResolver([])(stamp)).toBe("stale");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rebuilds notes after restart and excludes sibling-branch events", async () => {
		const harness = await createHarness({ persistSession: true });
		try {
			harness.sessionManager.appendCustomEntry("context-prompt-generation", {
				promptGeneration: 1,
				contextEpoch: 0,
			});
			const userEntryId = harness.sessionManager.appendMessage({
				role: "user",
				content: "Keep the API small.",
				timestamp: 1,
			});
			const candidate: ContextNoteToolInput = {
				operation: "upsert",
				kind: "constraint",
				key: "api.surface",
				text: "Keep the API small.",
				sourceRefs: [{ entryId: userEntryId }],
				evidenceRefs: [],
			};
			const toolCall = fauxToolCall("context_note", candidate);
			harness.sessionManager.appendMessage(fauxAssistantMessage(toolCall, { stopReason: "toolUse" }));
			await createContextNoteToolDefinition({
				sessionManager: harness.sessionManager,
				getPromptGeneration: () => 1,
				getContextEpoch: () => 2,
			}).execute(toolCall.id, candidate, undefined, undefined, {} as never);
			const sessionFile = harness.session.sessionFile;
			if (sessionFile === undefined) throw new Error("Expected a persisted session");
			const reopened = SessionManager.open(sessionFile);
			const reopenedBranch = reopened.getBranch();
			const reopenedScope = resolveTaskNoteScope(reopenedBranch, 1);
			if (reopenedScope === undefined) throw new Error("Expected a task scope");
			const restored = buildTaskNoteProjectionFromBranch(reopenedBranch, reopenedScope);
			expect(restored.status === "valid" ? restored.snapshot.items : []).toHaveLength(1);

			reopened.branch(userEntryId);
			const siblingBranch = reopened.getBranch();
			const siblingScope = resolveTaskNoteScope(siblingBranch, 1);
			if (siblingScope === undefined) throw new Error("Expected a sibling task scope");
			const sibling = buildTaskNoteProjectionFromBranch(siblingBranch, siblingScope);
			expect(sibling.status === "valid" ? sibling.snapshot.items : []).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});
});
