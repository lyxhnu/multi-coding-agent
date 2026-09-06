import { estimateTextTokens } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ContextReadBudgetReservation } from "../context-budget.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	acceptTaskNoteCandidate,
	buildTaskNoteProjectionFromBranch,
	createTaskNoteEventId,
	createTaskNoteFreshnessResolver,
	MAX_TASK_NOTE_EVIDENCE_REFS,
	MAX_TASK_NOTE_RESUME_REFS,
	MAX_TASK_NOTE_SOURCE_REFS,
	MAX_TASK_NOTE_TEXT_CHARS,
	resolveTaskNoteScope,
	type TaskNoteCandidate,
	type TaskNoteKind,
} from "../task-note-projection.ts";
import { queryTaskNotes } from "../task-note-query.ts";
import type { SessionTraceEvent } from "../trace.ts";

const referenceSchema = Type.Object(
	{
		entryId: Type.String({ minLength: 1, maxLength: 128 }),
		blockIndex: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const kindSchema = Type.Union([
	Type.Literal("constraint"),
	Type.Literal("decision"),
	Type.Literal("state"),
	Type.Literal("next_action"),
	Type.Literal("failed_attempt"),
]);

const resumeSchema = Type.Object(
	{
		relatedNotes: Type.Array(
			Type.Object(
				{ kind: kindSchema, key: Type.String({ minLength: 1, maxLength: 96 }) },
				{ additionalProperties: false },
			),
			{ maxItems: MAX_TASK_NOTE_RESUME_REFS },
		),
		requiredHistoryRefs: Type.Array(referenceSchema, { maxItems: MAX_TASK_NOTE_RESUME_REFS }),
		requirementSourceRefs: Type.Array(referenceSchema, { maxItems: MAX_TASK_NOTE_RESUME_REFS }),
		todoIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: MAX_TASK_NOTE_RESUME_REFS }),
	},
	{ additionalProperties: false },
);

const contextNoteSchema = Type.Union([
	Type.Object(
		{
			operation: Type.Literal("query"),
			kind: Type.Optional(kindSchema),
			key: Type.Optional(Type.String({ maxLength: 96 })),
			text: Type.Optional(Type.String({ maxLength: 1024 })),
			item: Type.Optional(Type.String({ maxLength: 128 })),
			resumeRef: Type.Optional(Type.String({ maxLength: 36 })),
			taskSourceEntryId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			cursor: Type.Optional(Type.String({ maxLength: 2048 })),
			budgetTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 2048 })),
			verify: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("upsert"),
			kind: kindSchema,
			key: Type.String({ pattern: "^[a-z0-9][a-z0-9._/-]{0,95}$" }),
			text: Type.String({ minLength: 1, maxLength: MAX_TASK_NOTE_TEXT_CHARS }),
			sourceRefs: Type.Array(referenceSchema, { minItems: 1, maxItems: MAX_TASK_NOTE_SOURCE_REFS }),
			evidenceRefs: Type.Array(referenceSchema, { maxItems: MAX_TASK_NOTE_EVIDENCE_REFS }),
			resume: Type.Optional(resumeSchema),
			supersedesEventId: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("retract"),
			kind: kindSchema,
			key: Type.String({ pattern: "^[a-z0-9][a-z0-9._/-]{0,95}$" }),
			sourceRefs: Type.Array(referenceSchema, { minItems: 1, maxItems: MAX_TASK_NOTE_SOURCE_REFS }),
			supersedesEventId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type ContextNoteToolInput = Static<typeof contextNoteSchema>;

export interface ContextNoteToolDetails {
	eventId: string;
	operation: "upsert" | "retract";
	kind: TaskNoteKind;
	key: string;
}

export interface ContextNoteToolOptions {
	reserveReadBudget?: (requestedTokens: number, toolCallId: string) => ContextReadBudgetReservation;
	sessionManager: SessionManager;
	getPromptGeneration: () => number;
	getContextEpoch: () => number;
	getTraceTurn?: () => number;
	onTrace?: (event: Extract<SessionTraceEvent, { type: "context/task_note" }>) => void;
}

export function createContextNoteToolDefinition(
	options: ContextNoteToolOptions,
): ToolDefinition<typeof contextNoteSchema> {
	return {
		name: "context_note",
		label: "context_note",
		description:
			"Query task notes or resolve the current resumeRef, or record a durable semantic change. Use updates only for constraints, decisions, " +
			"evidence-backed state, meaningful failed attempts, or a changed next action.",
		promptSnippet: "Record durable semantic changes with context_note",
		promptGuidelines: [
			"Call context_note only when losing the fact would change how the task should continue.",
			"Task notes index authoritative session evidence; they do not replace user messages, tool results, or todos.",
			"Use history to discover persisted sourceRefs and evidenceRefs. Query Note metadata first, then request an item by eventId to read its text and freshness. Resolve resumeRef with operation=query.",
			"When updating or retracting an active Note, pass its eventId as supersedesEventId; omit supersedesEventId when creating a new Note identity.",
		],
		parameters: contextNoteSchema,
		async execute(toolCallId, input) {
			if (input.operation === "query") {
				const reservation = options.reserveReadBudget?.(input.budgetTokens ?? 2048, toolCallId) ?? {
					tokens: null,
					settle: () => {},
				};
				try {
					const result = queryTaskNotes(
						options.sessionManager,
						options.getPromptGeneration(),
						input,
						reservation.tokens,
					);
					reservation.settle(estimateTextTokens(JSON.stringify(result)));
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				} catch (error) {
					reservation.settle(0);
					throw error;
				}
			}
			const candidate = input as TaskNoteCandidate;
			const reject = (reason: string): never => {
				options.onTrace?.({
					type: "context/task_note",
					data: {
						turn: options.getTraceTurn?.() ?? 0,
						promptGeneration: options.getPromptGeneration(),
						contextEpoch: options.getContextEpoch(),
						operation: candidate.operation,
						kind: candidate.kind,
						key: candidate.key,
						outcome: "rejected",
						reasonCode: reason,
					},
				});
				throw new Error(reason);
			};
			const branch = options.sessionManager.getBranch();
			const scope = resolveTaskNoteScope(branch, options.getPromptGeneration());
			if (scope === undefined) return reject("task_scope_unavailable");
			const projection = buildTaskNoteProjectionFromBranch(branch, scope, createTaskNoteFreshnessResolver(branch));
			if (projection.status !== "valid") return reject(projection.reason);

			const source = { type: "model_tool" as const, toolCallId };
			const eventId = createTaskNoteEventId(scope, source, candidate);
			const duplicate = projection.events.find((event) => event.eventId === eventId);
			if (duplicate !== undefined) {
				options.onTrace?.({
					type: "context/task_note",
					data: {
						turn: options.getTraceTurn?.() ?? 0,
						promptGeneration: options.getPromptGeneration(),
						contextEpoch: options.getContextEpoch(),
						operation: duplicate.operation,
						kind: duplicate.kind,
						key: duplicate.key,
						outcome: "accepted",
						eventId: duplicate.eventId,
					},
				});
				return {
					content: [
						{ type: "text", text: `Task note ${duplicate.operation}: ${duplicate.kind}/${duplicate.key}` },
					],
					details: {
						eventId: duplicate.eventId,
						operation: duplicate.operation,
						kind: duplicate.kind,
						key: duplicate.key,
					},
				};
			}

			const accepted = acceptTaskNoteCandidate(candidate, {
				scope,
				contextEpoch: options.getContextEpoch(),
				source,
				branch,
				projection: projection.snapshot,
			});
			if (accepted.status !== "accepted") return reject(accepted.reason);
			options.sessionManager.appendCustomEntry("task-note-event", accepted.event);
			options.onTrace?.({
				type: "context/task_note",
				data: {
					turn: options.getTraceTurn?.() ?? 0,
					promptGeneration: options.getPromptGeneration(),
					contextEpoch: options.getContextEpoch(),
					operation: accepted.event.operation,
					kind: accepted.event.kind,
					key: accepted.event.key,
					outcome: "accepted",
					eventId: accepted.event.eventId,
				},
			});
			return {
				content: [
					{
						type: "text",
						text: `Task note ${accepted.event.operation}: ${accepted.event.kind}/${accepted.event.key}`,
					},
				],
				details: {
					eventId: accepted.event.eventId,
					operation: accepted.event.operation,
					kind: accepted.event.kind,
					key: accepted.event.key,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold(`context_note ${args.operation} ${args.kind ?? ""}/${args.key ?? ""}`)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	};
}
