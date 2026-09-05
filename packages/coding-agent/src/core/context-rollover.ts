import { createHash } from "node:crypto";
import type { PreparedContinuation } from "@earendil-works/pi-agent-core";
import { applyRedactions } from "@earendil-works/pi-agent-core";
import type { ContextBudget, Usage } from "@earendil-works/pi-ai";
import {
	createPrefixCheckpointFromBoundary,
	isPrefixCheckpoint,
	type PrefixSummaryCheckpoint,
	validatePrefixCheckpoint,
} from "./compaction/checkpoint.ts";
import type {
	ContextMaintenanceBlockedReason,
	ContextMaintenanceCause,
	ContextMaintenanceOutcome,
	ContextMaintenanceSnapshot,
	ContinuationIntent,
} from "./compaction/context-maintenance.ts";
import { formatContextRolloverHandoff as formatHandoff } from "./messages.ts";
import { collectShakeRedactions, type SessionEntry } from "./session-manager.ts";
import {
	acceptTaskNoteCandidate,
	buildTaskNoteProjection,
	createTaskNoteBatchId,
	createTaskScopeId,
	isTaskNoteBatch,
	MAX_CHECKPOINT_NOTE_CANDIDATES,
	type TaskNoteBatch,
	type TaskNoteCandidate,
	type TaskNoteEvent,
	type TaskNoteProjectionSnapshot,
	type TaskNoteReference,
	type TaskNoteScope,
} from "./task-note-projection.ts";
import type { TodoPriority } from "./todo/todo-state.ts";

export interface ContextRolloverAcceptanceCriteria {
	status: "specified" | "not_specified";
	items: Array<{ text: string; sourceEntryIds: string[]; taskContractIds: string[] }>;
}

export interface ContextRolloverNote {
	version: 1;
	objective: { text: string; sourceEntryIds: string[] };
	userConstraints: Array<{ text: string; sourceEntryIds: string[] }>;
	acceptanceCriteria: ContextRolloverAcceptanceCriteria;
	decisions: Array<{ text: string; reason: string; sourceEntryIds: string[] }>;
	completedWork: Array<{ text: string; todoIds: string[]; evidenceEntryIds: string[] }>;
	currentState: { text: string; evidenceEntryIds: string[] };
	failedAttempts: Array<{ text: string; reason: string; evidenceEntryIds: string[] }>;
	nextAction: { text: string; evidenceEntryIds: string[] };
	historyRefs: Array<{ entryId: string; blockIndex?: number; purpose: string }>;
}

export interface ContextRolloverCheckpoint {
	version: 1;
	checkpointId: string;
	promptGeneration: number;
	contextEpoch: number;
	coveredStartEntryId: string;
	coveredEndEntryId: string;
	coveredEntryIds: string[];
	sourcePrefixFingerprint: string;
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	requestConfigFingerprint: string;
	compactionPrefix: PrefixSummaryCheckpoint;
	note: ContextRolloverNote;
}

export interface ContextRolloverCheckpointEnvelope {
	version: 1;
	checkpoint: ContextRolloverCheckpoint;
	taskNoteBatch: TaskNoteBatch;
}

export interface ContextRolloverCheckpointOutput {
	checkpoint: ContextRolloverNote;
	noteUpdateCandidates: TaskNoteCandidate[];
}

export interface ActiveRolloverTodo {
	id: string;
	content: string;
	priority: TodoPriority;
	status: "pending" | "in_progress";
}

export interface ContextRolloverBundle {
	version: 1;
	checkpointId: string;
	checkpointEntryId: string;
	promptGeneration: number;
	sourceContextEpoch: number;
	targetContextEpoch: number;
	note: ContextRolloverNote;
	activeTodosAtCommit: ActiveRolloverTodo[];
	todoStateEntryIdAtCommit: string | null;
	todoStateFingerprintAtCommit: string;
	activeEntryIds: string[];
	historyAllowlist: Array<{ entryId: string; blockIndex?: number }>;
	sourceFingerprint: string;
	progressBaselineFingerprint: string;
	taskNoteProjectionRevision: string;
}

export interface ContextRolloverRevisions {
	sessionLeafId: string | null;
	sourceFingerprint: string;
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	queueRevision: string;
	progressRevision: string;
	requestConfigFingerprint: string;
}

export type ContextRolloverCommitResult =
	| { status: "committed"; entryId: string }
	| { status: "superseded" }
	| { status: "failed" };

export type ContextRolloverCheckpointReason =
	| "below_prefire_threshold"
	| "operation_limit"
	| "operation_in_flight"
	| "no_complete_tool_transaction"
	| "provider_failed"
	| "authorization_failed"
	| "wall_clock_exhausted"
	| "invalid_output"
	| "invalid_evidence"
	| "unsafe_content"
	| "note_too_large"
	| "source_changed";

export interface ContextRolloverCheckpointRequest {
	promptGeneration: number;
	contextEpoch: number;
	snapshot: ContextMaintenanceSnapshot;
	signal?: AbortSignal;
}

export type ContextRolloverCheckpointOutcome =
	| { outcome: "committed"; checkpointId: string; checkpointEntryId: string }
	| {
			outcome: "not_started" | "discarded";
			checkpointId?: string;
			reason: ContextRolloverCheckpointReason;
	  }
	| { outcome: "cancelled"; checkpointId?: string };

export interface ContextRolloverDependencies {
	prepareCheckpoint: (request: ContextRolloverCheckpointRequest) => Promise<ContextRolloverCheckpointOutcome>;
	runRollover: (request: ContextRolloverRequest) => Promise<ContextRolloverOutcome>;
}

export type ContextRolloverBlockedReason =
	| "ineligible_maintenance_reason"
	| "continuation_forbidden"
	| "task_complete"
	| "operation_in_flight"
	| "rollover_already_used"
	| "rollover_limit"
	| "checkpoint_missing"
	| "checkpoint_invalid"
	| "tool_transaction_incomplete"
	| "active_suffix_too_large"
	| "handoff_invalid"
	| "source_changed"
	| "todo_changed"
	| "queue_changed"
	| "request_config_changed"
	| "no_strong_progress"
	| "invalid_continuation_context"
	| "prepared_context_limit"
	| "prepared_over_half_window"
	| "unchanged_request"
	| "post_commit_mismatch"
	| "dispatch_prepare_mismatch"
	| "dispatch_outcome_unknown";

export interface ContextRolloverRequest {
	sourceMaintenanceId: string;
	promptGeneration: number;
	contextEpoch: number;
	maintenanceCause: Extract<ContextMaintenanceCause, "budget_limit" | "provider_overflow">;
	maintenanceBlockedReason: Extract<
		ContextMaintenanceBlockedReason,
		"methods_exhausted" | "no_progress" | "attempt_limit"
	>;
	continuation: "required";
	sourceRequestFingerprint: string;
	signal?: AbortSignal;
}

export type ContextRolloverOutcome =
	| {
			outcome: "ready";
			rolloverId: string;
			entryId: string;
			targetContextEpoch: number;
			preparation: PreparedContinuation;
	  }
	| { outcome: "blocked"; rolloverId: string; committed: boolean; reason: ContextRolloverBlockedReason }
	| { outcome: "cancelled"; rolloverId: string; committed: false };

export async function prepareContextRolloverCheckpoint(
	request: ContextRolloverCheckpointRequest,
	dependencies: ContextRolloverDependencies,
): Promise<ContextRolloverCheckpointOutcome> {
	if (request.signal?.aborted) return { outcome: "cancelled" };
	return await dependencies.prepareCheckpoint(request);
}

export async function runContextRollover(
	request: ContextRolloverRequest,
	dependencies: ContextRolloverDependencies,
): Promise<ContextRolloverOutcome> {
	return await dependencies.runRollover(request);
}

const ELIGIBLE_REASONS = new Set<ContextMaintenanceBlockedReason>([
	"methods_exhausted",
	"no_progress",
	"attempt_limit",
]);

export function shouldStartContextRollover(input: {
	maintenance: ContextMaintenanceOutcome;
	cause: ContextMaintenanceCause;
	continuation: ContinuationIntent;
	taskIsIncomplete: boolean;
}): boolean {
	return (
		input.maintenance.outcome === "blocked" &&
		(input.cause === "budget_limit" || input.cause === "provider_overflow") &&
		input.continuation === "required" &&
		ELIGIBLE_REASONS.has(input.maintenance.reason) &&
		input.taskIsIncomplete
	);
}

export function collectCompleteToolTransactions(entries: readonly SessionEntry[]): string[][] {
	const visible = entries.filter((entry) => entry.type === "message" || entry.type === "custom_message");
	const transactions: string[][] = [];
	for (let index = 0; index < visible.length; index++) {
		const entry = visible[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				throw new Error("tool_transaction_incomplete");
			}
			transactions.push([entry.id]);
			continue;
		}
		const toolCallIds = entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
		if (toolCallIds.length === 0) {
			transactions.push([entry.id]);
			continue;
		}
		const expected = new Set(toolCallIds);
		const transaction = [entry.id];
		while (expected.size > 0) {
			const result = visible[++index];
			if (result?.type !== "message" || result.message.role !== "toolResult") {
				throw new Error("tool_transaction_incomplete");
			}
			if (!expected.delete(result.message.toolCallId)) {
				throw new Error("tool_transaction_incomplete");
			}
			transaction.push(result.id);
		}
		transactions.push(transaction);
	}
	return transactions;
}

export function validateContextRolloverNote(
	note: ContextRolloverNote,
	branch: readonly SessionEntry[],
	allowedSourceEntryIds?: ReadonlySet<string>,
): void {
	if (!isStrictContextRolloverNote(note)) throw new Error("invalid_output");
	const noteTexts = [
		note.objective.text,
		...note.userConstraints.flatMap((constraint) => [constraint.text]),
		...note.acceptanceCriteria.items.map((criterion) => criterion.text),
		...note.decisions.flatMap((decision) => [decision.text, decision.reason]),
		...note.completedWork.map((work) => work.text),
		note.currentState.text,
		...note.failedAttempts.flatMap((attempt) => [attempt.text, attempt.reason]),
		note.nextAction.text,
		...note.historyRefs.map((reference) => reference.purpose),
	];
	if (noteTexts.some((text) => containsPotentialSecret(text))) throw new Error("unsafe_content");
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const userSourceIds = [
		...note.objective.sourceEntryIds,
		...note.userConstraints.flatMap((constraint) => constraint.sourceEntryIds),
		...note.acceptanceCriteria.items.flatMap((criterion) => criterion.sourceEntryIds),
	];
	if (
		note.objective.sourceEntryIds.length === 0 ||
		userSourceIds.some(
			(id) => !isUserSource(byId.get(id)) || (allowedSourceEntryIds && !allowedSourceEntryIds.has(id)),
		)
	) {
		throw new Error("invalid_evidence");
	}
	if (
		(note.acceptanceCriteria.status === "specified" && note.acceptanceCriteria.items.length === 0) ||
		(note.acceptanceCriteria.status === "not_specified" && note.acceptanceCriteria.items.length !== 0)
	) {
		throw new Error("invalid_evidence");
	}
	for (const criterion of note.acceptanceCriteria.items) {
		if (criterion.sourceEntryIds.length === 0 && criterion.taskContractIds.length === 0) {
			throw new Error("invalid_evidence");
		}
		if (
			criterion.taskContractIds.some((id) => {
				const source = byId.get(id);
				return (
					source?.type !== "custom" ||
					source.customType !== "task-contract" ||
					(allowedSourceEntryIds !== undefined && !allowedSourceEntryIds.has(id))
				);
			})
		) {
			throw new Error("invalid_evidence");
		}
	}
	for (const work of note.completedWork) {
		if (
			work.evidenceEntryIds.length === 0 ||
			work.evidenceEntryIds.some(
				(id) => !isCompletedWorkEvidence(byId.get(id)) || (allowedSourceEntryIds && !allowedSourceEntryIds.has(id)),
			)
		) {
			throw new Error("invalid_evidence");
		}
	}
	for (const decision of note.decisions) {
		if (
			decision.sourceEntryIds.length === 0 ||
			decision.sourceEntryIds.some((id) => {
				const source = byId.get(id);
				return !isDecisionSource(source) || (allowedSourceEntryIds !== undefined && !allowedSourceEntryIds.has(id));
			})
		) {
			throw new Error("invalid_evidence");
		}
	}
	for (const attempt of note.failedAttempts) {
		if (
			attempt.evidenceEntryIds.length === 0 ||
			attempt.evidenceEntryIds.some((id) => {
				const source = byId.get(id);
				return (
					!isFailedAttemptEvidence(source) ||
					(allowedSourceEntryIds !== undefined && !allowedSourceEntryIds.has(id))
				);
			})
		) {
			throw new Error("invalid_evidence");
		}
	}
	if (
		note.currentState.evidenceEntryIds.length === 0 ||
		note.currentState.evidenceEntryIds.some((id) => {
			const source = byId.get(id);
			return (
				!isCurrentStateEvidence(source) || (allowedSourceEntryIds !== undefined && !allowedSourceEntryIds.has(id))
			);
		})
	) {
		throw new Error("invalid_evidence");
	}
	if (
		note.nextAction.evidenceEntryIds.some((id) => {
			const source = byId.get(id);
			return !isDecisionSource(source) || (allowedSourceEntryIds !== undefined && !allowedSourceEntryIds.has(id));
		})
	) {
		throw new Error("invalid_evidence");
	}
	for (const reference of note.historyRefs) {
		const source = byId.get(reference.entryId);
		if (
			!isHistorySource(source) ||
			!isReadableHistoryBlock(source, reference.blockIndex) ||
			(allowedSourceEntryIds && !allowedSourceEntryIds.has(reference.entryId))
		) {
			throw new Error("invalid_evidence");
		}
	}
	const references = new Set([
		...userSourceIds,
		...note.acceptanceCriteria.items.flatMap((criterion) => criterion.taskContractIds),
		...note.decisions.flatMap((decision) => decision.sourceEntryIds),
		...note.completedWork.flatMap((work) => work.evidenceEntryIds),
		...note.currentState.evidenceEntryIds,
		...note.failedAttempts.flatMap((attempt) => attempt.evidenceEntryIds),
		...note.nextAction.evidenceEntryIds,
		...note.historyRefs.map((reference) => reference.entryId),
	]);
	if (
		references.size > 64 ||
		note.historyRefs.length > 32 ||
		[...references].some((id) => !byId.has(id) || (allowedSourceEntryIds && !allowedSourceEntryIds.has(id)))
	) {
		throw new Error("invalid_evidence");
	}
}

function isCurrentStateEvidence(entry: SessionEntry | undefined): boolean {
	return (
		(entry?.type === "message" &&
			(entry.message.role === "user" || (entry.message.role === "toolResult" && entry.message.isError !== true))) ||
		(entry?.type === "context_progress" && entry.outcome === "succeeded")
	);
}

function isDecisionSource(entry: SessionEntry | undefined): boolean {
	return (
		entry?.type === "message" ||
		entry?.type === "context_progress" ||
		(entry?.type === "custom_message" && entry.customType === "user-provenance")
	);
}

function isFailedAttemptEvidence(entry: SessionEntry | undefined): boolean {
	return (
		(entry?.type === "message" && entry.message.role === "toolResult" && entry.message.isError === true) ||
		(entry?.type === "context_progress" && entry.outcome === "failed")
	);
}

function isStrictContextRolloverNote(value: unknown): value is ContextRolloverNote {
	if (
		!isRecord(value) ||
		!hasExactlyKeys(value, [
			"version",
			"objective",
			"userConstraints",
			"acceptanceCriteria",
			"decisions",
			"completedWork",
			"currentState",
			"failedAttempts",
			"nextAction",
			"historyRefs",
		])
	)
		return false;
	const objective = value.objective;
	const acceptanceCriteria = value.acceptanceCriteria;
	const currentState = value.currentState;
	const nextAction = value.nextAction;
	return (
		value.version === 1 &&
		isEvidenceText(objective, ["text", "sourceEntryIds"]) &&
		isRecord(acceptanceCriteria) &&
		hasExactlyKeys(acceptanceCriteria, ["status", "items"]) &&
		(acceptanceCriteria.status === "specified" || acceptanceCriteria.status === "not_specified") &&
		Array.isArray(acceptanceCriteria.items) &&
		acceptanceCriteria.items.every((item) => isEvidenceText(item, ["text", "sourceEntryIds", "taskContractIds"])) &&
		isEvidenceText(currentState, ["text", "evidenceEntryIds"]) &&
		isEvidenceText(nextAction, ["text", "evidenceEntryIds"]) &&
		Array.isArray(value.userConstraints) &&
		value.userConstraints.every((item) => isEvidenceText(item, ["text", "sourceEntryIds"])) &&
		Array.isArray(value.decisions) &&
		value.decisions.every((item) => isEvidenceText(item, ["text", "reason", "sourceEntryIds"])) &&
		Array.isArray(value.completedWork) &&
		value.completedWork.every((item) => isEvidenceText(item, ["text", "todoIds", "evidenceEntryIds"])) &&
		Array.isArray(value.failedAttempts) &&
		value.failedAttempts.every((item) => isEvidenceText(item, ["text", "reason", "evidenceEntryIds"])) &&
		Array.isArray(value.historyRefs) &&
		value.historyRefs.every((item) => {
			if (!isRecord(item) || !hasExactlyKeys(item, ["entryId", "purpose"], ["blockIndex"])) {
				return false;
			}
			return (
				typeof item.entryId === "string" &&
				item.entryId.length > 0 &&
				typeof item.purpose === "string" &&
				item.purpose.trim().length > 0 &&
				(item.blockIndex === undefined ||
					(typeof item.blockIndex === "number" && Number.isInteger(item.blockIndex) && item.blockIndex >= -1))
			);
		})
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isEvidenceText(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!isRecord(value) || !hasExactlyKeys(value, keys)) return false;
	if (typeof value.text !== "string" || value.text.trim().length === 0) return false;
	if ("reason" in value && (typeof value.reason !== "string" || value.reason.trim().length === 0)) return false;
	for (const key of ["sourceEntryIds", "taskContractIds", "todoIds", "evidenceEntryIds"]) {
		if (key in value && !isNonEmptyOrEmptyStringArray(value[key])) return false;
	}
	return true;
}

function isNonEmptyOrEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isCompletedWorkEvidence(entry: SessionEntry | undefined): boolean {
	if (!entry) return false;
	if (
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		entry.type === "context_rollover" ||
		entry.type === "context_rollover_dispatch" ||
		entry.type === "context_operation" ||
		entry.type === "trace" ||
		entry.type === "pending_delivery" ||
		entry.type === "delivery_receipt" ||
		entry.type === "delivery_cancelled" ||
		(entry.type === "custom" && entry.customType === "context-rollover-checkpoint")
	) {
		return false;
	}
	if (entry.type === "message" && entry.message.role === "toolResult") return entry.message.isError !== true;
	return (
		(entry.type === "message" && entry.message.role === "user") ||
		(entry.type === "custom_message" && entry.customType === "user-provenance") ||
		(entry.type === "context_progress" &&
			entry.outcome === "succeeded" &&
			(entry.evidenceKind === "verification" || entry.evidenceKind === "task_completed"))
	);
}

function isHistorySource(
	entry: SessionEntry | undefined,
): entry is Extract<SessionEntry, { type: "message" | "custom_message" }> {
	return entry?.type === "message" || entry?.type === "custom_message";
}

function isReadableHistoryBlock(
	entry: Extract<SessionEntry, { type: "message" | "custom_message" }>,
	blockIndex: number | undefined,
): boolean {
	let content: unknown;
	if (entry.type === "custom_message") {
		content = entry.content;
	} else if (isRecord(entry.message) && "content" in entry.message) {
		content = entry.message.content;
	} else {
		return false;
	}
	if (typeof content === "string") return blockIndex === undefined || blockIndex === -1;
	if (!Array.isArray(content)) return false;
	const textIndexes = content.flatMap((block: unknown, index: number) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string" ? [index] : [],
	);
	if (blockIndex === undefined) return textIndexes.length === 1;
	return blockIndex >= 0 && textIndexes.includes(blockIndex);
}

export function selectLatestContextRolloverCheckpoint(
	branch: readonly SessionEntry[],
	promptGeneration: number,
	contextEpoch: number,
): { entryId: string; checkpoint: ContextRolloverCheckpoint; envelope: ContextRolloverCheckpointEnvelope } | undefined {
	const sourceBranch = branch.filter(
		(entry) => !(entry.type === "custom" && entry.customType === "context-rollover-checkpoint"),
	);
	const sourceEntries = applyRedactions(sourceBranch, collectShakeRedactions(sourceBranch));
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== "context-rollover-checkpoint") continue;
		if (!isContextRolloverCheckpointEnvelope(entry.data)) continue;
		const envelope = entry.data;
		const checkpoint = envelope.checkpoint;
		if (checkpoint.promptGeneration !== promptGeneration || checkpoint.contextEpoch !== contextEpoch) continue;
		const coveredEndBranchIndex = branch.findIndex((candidate) => candidate.id === checkpoint.coveredEndEntryId);
		if (coveredEndBranchIndex < 0 || coveredEndBranchIndex >= index) continue;
		const coveredStartIndex = sourceEntries.findIndex((candidate) => candidate.id === checkpoint.coveredStartEntryId);
		const coveredEndIndex = sourceEntries.findIndex((candidate) => candidate.id === checkpoint.coveredEndEntryId);
		const covered = checkpoint.coveredEntryIds.flatMap((id) => {
			const source = sourceEntries.find((candidate) => candidate.id === id);
			return source ? [source] : [];
		});
		const contiguousCovered =
			coveredStartIndex >= 0 &&
			coveredEndIndex >= coveredStartIndex &&
			sourceEntries
				.slice(coveredStartIndex, coveredEndIndex + 1)
				.filter((candidate) => candidate.type === "message" || candidate.type === "custom_message")
				.map((candidate) => candidate.id);
		if (
			covered.length !== checkpoint.coveredEntryIds.length ||
			covered[0]?.id !== checkpoint.coveredStartEntryId ||
			covered.at(-1)?.id !== checkpoint.coveredEndEntryId ||
			JSON.stringify(contiguousCovered) !== JSON.stringify(checkpoint.coveredEntryIds) ||
			fingerprintContextRolloverValue(covered) !== checkpoint.sourcePrefixFingerprint
		) {
			continue;
		}
		try {
			if (!validatePrefixCheckpoint(sourceEntries, checkpoint.compactionPrefix)) {
				throw new Error("invalid_compaction_prefix");
			}
			const allowedSourceEntryIds = new Set(
				sourceEntries
					.slice(coveredStartIndex, coveredEndIndex + 1)
					.filter(
						(candidate) =>
							candidate.type === "message" ||
							candidate.type === "custom_message" ||
							candidate.type === "context_progress" ||
							(candidate.type === "custom" && candidate.customType === "task-contract"),
					)
					.map((candidate) => candidate.id),
			);
			if (contextEpoch > 0) {
				const previousRollover = sourceEntries
					.slice(0, index)
					.reverse()
					.find(
						(candidate): candidate is Extract<SessionEntry, { type: "context_rollover" }> =>
							candidate.type === "context_rollover" && candidate.targetContextEpoch === contextEpoch,
					);
				if (previousRollover) {
					for (const id of collectNoteReferenceIds(previousRollover.bundle.note)) allowedSourceEntryIds.add(id);
				}
			}
			validateContextRolloverNote(checkpoint.note, sourceEntries, allowedSourceEntryIds);
			const coveredIds = new Set(checkpoint.coveredEntryIds);
			for (const transaction of collectCompleteToolTransactions(sourceEntries)) {
				const count = transaction.filter((id) => coveredIds.has(id)).length;
				if (count > 0 && count !== transaction.length) throw new Error("tool_transaction_incomplete");
			}
		} catch {
			continue;
		}
		return { entryId: entry.id, checkpoint, envelope };
	}
	return undefined;
}

function collectNoteReferenceIds(note: ContextRolloverNote): string[] {
	return [...collectNoteClaimReferenceIds(note), ...note.historyRefs.map((reference) => reference.entryId)];
}

function collectNoteClaimReferenceIds(note: ContextRolloverNote): string[] {
	return [
		...note.objective.sourceEntryIds,
		...note.userConstraints.flatMap((constraint) => constraint.sourceEntryIds),
		...note.acceptanceCriteria.items.flatMap((criterion) => criterion.sourceEntryIds),
		...note.acceptanceCriteria.items.flatMap((criterion) => criterion.taskContractIds),
		...note.decisions.flatMap((decision) => decision.sourceEntryIds),
		...note.completedWork.flatMap((work) => work.evidenceEntryIds),
		...note.currentState.evidenceEntryIds,
		...note.failedAttempts.flatMap((attempt) => attempt.evidenceEntryIds),
		...note.nextAction.evidenceEntryIds,
	];
}

function isContextRolloverCheckpoint(value: unknown): value is ContextRolloverCheckpoint {
	if (
		!isRecord(value) ||
		!hasExactlyKeys(value, [
			"version",
			"checkpointId",
			"promptGeneration",
			"contextEpoch",
			"coveredStartEntryId",
			"coveredEndEntryId",
			"coveredEntryIds",
			"sourcePrefixFingerprint",
			"todoStateEntryId",
			"todoStateFingerprint",
			"requestConfigFingerprint",
			"compactionPrefix",
			"note",
		])
	) {
		return false;
	}
	const checkpoint = value as Partial<ContextRolloverCheckpoint>;
	return (
		checkpoint.version === 1 &&
		typeof checkpoint.checkpointId === "string" &&
		checkpoint.checkpointId.length > 0 &&
		Number.isInteger(checkpoint.promptGeneration) &&
		(checkpoint.promptGeneration ?? -1) >= 0 &&
		Number.isInteger(checkpoint.contextEpoch) &&
		(checkpoint.contextEpoch ?? -1) >= 0 &&
		typeof checkpoint.coveredStartEntryId === "string" &&
		checkpoint.coveredStartEntryId.length > 0 &&
		typeof checkpoint.coveredEndEntryId === "string" &&
		checkpoint.coveredEndEntryId.length > 0 &&
		Array.isArray(checkpoint.coveredEntryIds) &&
		checkpoint.coveredEntryIds.length > 0 &&
		checkpoint.coveredEntryIds.every((id) => typeof id === "string" && id.length > 0) &&
		typeof checkpoint.sourcePrefixFingerprint === "string" &&
		checkpoint.sourcePrefixFingerprint.length > 0 &&
		(checkpoint.todoStateEntryId === null || typeof checkpoint.todoStateEntryId === "string") &&
		typeof checkpoint.todoStateFingerprint === "string" &&
		checkpoint.todoStateFingerprint.length > 0 &&
		typeof checkpoint.requestConfigFingerprint === "string" &&
		checkpoint.requestConfigFingerprint.length > 0 &&
		isPrefixCheckpoint(checkpoint.compactionPrefix) &&
		checkpoint.compactionPrefix.coveredEndEntryId === checkpoint.coveredEndEntryId &&
		isStrictContextRolloverNote(checkpoint.note)
	);
}

export function isContextRolloverCheckpointEnvelope(value: unknown): value is ContextRolloverCheckpointEnvelope {
	if (!isRecord(value) || !hasExactlyKeys(value, ["version", "checkpoint", "taskNoteBatch"])) return false;
	return (
		value.version === 1 &&
		isContextRolloverCheckpoint(value.checkpoint) &&
		isTaskNoteBatch(value.taskNoteBatch, value.checkpoint.checkpointId)
	);
}

export function assembleContextRolloverBundle(input: {
	checkpoint: ContextRolloverCheckpoint;
	checkpointEntryId: string;
	contextEntries: readonly SessionEntry[];
	taskNoteProjection: TaskNoteProjectionSnapshot;
	targetContextEpoch: number;
	activeTodos: ActiveRolloverTodo[];
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	progressBaselineFingerprint: string;
}): ContextRolloverBundle {
	const coveredIds = new Set(input.checkpoint.coveredEntryIds);
	const coveredEndIndex = input.contextEntries.findIndex((entry) => entry.id === input.checkpoint.coveredEndEntryId);
	if (coveredEndIndex < 0) throw new Error("checkpoint_invalid");
	const transactions = collectCompleteToolTransactions(input.contextEntries);
	for (const transaction of transactions) {
		const count = transaction.filter((id) => coveredIds.has(id)).length;
		if (count > 0 && count !== transaction.length) throw new Error("tool_transaction_incomplete");
	}
	const activeEntryIds = transactions
		.filter((transaction) => {
			const firstIndex = input.contextEntries.findIndex((entry) => entry.id === transaction[0]);
			return firstIndex > coveredEndIndex;
		})
		.flat();
	const note = mergeTaskNoteProjection(input.checkpoint.note, input.taskNoteProjection, input.activeTodos);
	validateContextRolloverNote(note, input.contextEntries);
	const usedProjectionItems = input.taskNoteProjection.items.filter((item) => {
		if (item.kind === "constraint") return note.userConstraints.some((constraint) => constraint.text === item.text);
		if (item.kind === "decision") return note.decisions.some((decision) => decision.text === item.text);
		if (item.kind === "state") return note.currentState.text.includes(item.text);
		if (item.kind === "failed_attempt") return note.failedAttempts.some((attempt) => attempt.text === item.text);
		return note.nextAction.text.includes(item.text);
	});
	const historyReferences: TaskNoteReference[] = [
		...collectNoteClaimReferenceIds(note).map((entryId) => ({ entryId })),
		...note.historyRefs,
		...usedProjectionItems.flatMap((item) => item.sourceRefs),
		...usedProjectionItems.flatMap((item) => item.evidence.map((stamp) => stamp.reference)),
	];
	const entriesById = new Map(input.contextEntries.map((entry) => [entry.id, entry]));
	const activeEntryIdSet = new Set(activeEntryIds);
	const historyAllowlist = [
		...new Map(
			historyReferences.flatMap((reference) => {
				const entry = entriesById.get(reference.entryId);
				if (!isHistorySource(entry) || activeEntryIdSet.has(reference.entryId)) return [];
				const normalized = {
					entryId: reference.entryId,
					...(reference.blockIndex === undefined ? {} : { blockIndex: reference.blockIndex }),
				};
				return [[`${normalized.entryId}\u0000${normalized.blockIndex ?? ""}`, normalized] as const];
			}),
		).values(),
	];
	return {
		version: 1,
		checkpointId: input.checkpoint.checkpointId,
		checkpointEntryId: input.checkpointEntryId,
		promptGeneration: input.checkpoint.promptGeneration,
		sourceContextEpoch: input.checkpoint.contextEpoch,
		targetContextEpoch: input.targetContextEpoch,
		note,
		activeTodosAtCommit: structuredClone(input.activeTodos),
		todoStateEntryIdAtCommit: input.todoStateEntryId,
		todoStateFingerprintAtCommit: input.todoStateFingerprint,
		activeEntryIds,
		historyAllowlist,
		sourceFingerprint: fingerprintContextRolloverValue(input.contextEntries),
		progressBaselineFingerprint: input.progressBaselineFingerprint,
		taskNoteProjectionRevision: input.taskNoteProjection.revision,
	};
}

function mergeTaskNoteProjection(
	checkpoint: ContextRolloverNote,
	projection: TaskNoteProjectionSnapshot,
	activeTodos: readonly ActiveRolloverTodo[],
): ContextRolloverNote {
	const note = structuredClone(checkpoint);
	for (const item of projection.items) {
		const sourceEntryIds = item.sourceRefs.map((reference) => reference.entryId);
		const evidenceEntryIds = item.evidence.map((evidence) => evidence.observedAtEntryId);
		if (item.kind === "constraint") {
			if (!note.userConstraints.some((constraint) => constraint.text === item.text)) {
				note.userConstraints.push({ text: item.text, sourceEntryIds });
			}
		} else if (item.kind === "decision") {
			if (!note.decisions.some((decision) => decision.text === item.text)) {
				note.decisions.push({ text: item.text, reason: "Current Task Note decision.", sourceEntryIds });
			}
		} else if (item.kind === "state") {
			note.currentState = {
				text:
					item.freshness === "fresh"
						? item.text
						: `${item.text} This was previously observed, but its current validity is ${item.freshness}; revalidation is required.`,
				evidenceEntryIds,
			};
		} else if (item.kind === "failed_attempt") {
			if (!note.failedAttempts.some((attempt) => attempt.text === item.text)) {
				note.failedAttempts.push({
					text: item.text,
					reason: "Recorded failed attempt with system-stamped evidence.",
					evidenceEntryIds,
				});
			}
		} else if (activeTodos.length === 0) {
			note.nextAction = {
				text:
					item.freshness === "stale" || item.freshness === "unknown"
						? `${item.text} Revalidate its prerequisites before continuing.`
						: item.text,
				evidenceEntryIds,
			};
		}
	}
	if (activeTodos.length > 0) {
		note.nextAction = { text: activeTodos[0].content, evidenceEntryIds: [] };
	}
	return note;
}

export function validateFinalHandoff(input: {
	bundle: ContextRolloverBundle;
	branch: readonly SessionEntry[];
	projection: TaskNoteProjectionSnapshot;
	activeTodos: readonly ActiveRolloverTodo[];
	contextWindow: number;
}): void {
	validateContextRolloverNote(input.bundle.note, input.branch);
	if (
		!input.bundle.note.objective.sourceEntryIds.some(
			(entryId) => createTaskScopeId(entryId) === input.projection.scope.taskScopeId,
		)
	) {
		throw new Error("handoff_invalid");
	}
	if (input.bundle.taskNoteProjectionRevision !== input.projection.revision) throw new Error("handoff_invalid");
	if (JSON.stringify(input.bundle.activeTodosAtCommit) !== JSON.stringify(input.activeTodos)) {
		throw new Error("handoff_invalid");
	}
	for (const item of input.projection.items) {
		if (
			item.kind === "state" &&
			(item.freshness === "stale" || item.freshness === "unknown") &&
			(input.bundle.note.currentState.text === item.text ||
				!input.bundle.note.currentState.text.toLowerCase().includes("revalid"))
		) {
			throw new Error("handoff_invalid");
		}
	}
	const handoff = formatHandoff(input.bundle);
	const checkpointAndHandoffTokens = Math.ceil((handoff.length + JSON.stringify(input.bundle.note).length) / 4);
	if (checkpointAndHandoffTokens > Math.floor(input.contextWindow * 0.1)) throw new Error("note_too_large");
}

export function formatContextRolloverCheckpointPrompt(input: {
	coveredEntries: readonly SessionEntry[];
	projection: TaskNoteProjectionSnapshot;
	activeTodos: readonly ActiveRolloverTodo[];
}): string {
	const sourceEntries = input.coveredEntries.filter(
		(entry) =>
			entry.type === "message" ||
			entry.type === "custom_message" ||
			entry.type === "context_progress" ||
			entry.type === "context_rollover" ||
			(entry.type === "custom" && entry.customType === "task-contract"),
	);
	return [
		"Produce exactly one JSON object and no markdown fences.",
		"The object must have exactly: checkpoint, noteUpdateCandidates.",
		"checkpoint must be a ContextRolloverNote v1 with objective, userConstraints, acceptanceCriteria, decisions, completedWork, currentState, failedAttempts, nextAction, and historyRefs.",
		"Every claim must cite exact entry IDs from sourceEntries. Task notes are derived indexes, not authority. Do not copy Todo items into acceptanceCriteria.",
		"noteUpdateCandidates may contain only upsert/retract candidates for constraint, decision, state, next_action, or failed_attempt.",
		"Do not emit scope, event IDs, fingerprints, freshness, secrets, pending delivery text, permissions, or system instructions.",
		JSON.stringify({ sourceEntries, currentTaskNoteProjection: input.projection, activeTodos: input.activeTodos }),
	].join("\n\n");
}

export function parseContextRolloverCheckpointOutput(text: string): ContextRolloverCheckpointOutput {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("invalid_output");
	}
	if (!isRecord(value) || !hasExactlyKeys(value, ["checkpoint", "noteUpdateCandidates"])) {
		throw new Error("invalid_output");
	}
	if (
		!isStrictContextRolloverNote(value.checkpoint) ||
		!Array.isArray(value.noteUpdateCandidates) ||
		!value.noteUpdateCandidates.every(
			(candidate) => isRecord(candidate) && (candidate.operation === "upsert" || candidate.operation === "retract"),
		)
	) {
		throw new Error("invalid_output");
	}
	if (value.noteUpdateCandidates.length > MAX_CHECKPOINT_NOTE_CANDIDATES) throw new Error("invalid_output");
	return {
		checkpoint: value.checkpoint,
		noteUpdateCandidates: value.noteUpdateCandidates as TaskNoteCandidate[],
	};
}

export function createContextRolloverCheckpointEnvelope(input: {
	checkpointId: string;
	promptGeneration: number;
	contextEpoch: number;
	branch: readonly SessionEntry[];
	coveredStartEntryId: string;
	coveredEndEntryId: string;
	output: ContextRolloverCheckpointOutput;
	taskNoteScope: TaskNoteScope;
	taskNoteProjection: TaskNoteProjectionSnapshot;
	taskNoteEvents: readonly TaskNoteEvent[];
	todoStateEntryId: string | null;
	todoStateFingerprint: string;
	requestConfigFingerprint: string;
	usage?: Usage;
}): ContextRolloverCheckpointEnvelope {
	const start = input.branch.findIndex((entry) => entry.id === input.coveredStartEntryId);
	const end = input.branch.findIndex((entry) => entry.id === input.coveredEndEntryId);
	if (start < 0 || end < start) throw new Error("invalid_output");
	const covered = input.branch
		.slice(start, end + 1)
		.filter((entry) => entry.type === "message" || entry.type === "custom_message");
	if (covered.length === 0) throw new Error("invalid_output");
	const transactions = collectCompleteToolTransactions(covered);
	if (transactions.flat().length !== covered.length) throw new Error("tool_transaction_incomplete");
	const allowedSourceEntryIds = new Set(input.branch.slice(start, end + 1).map((entry) => entry.id));
	if (input.contextEpoch > 0) {
		const previousRollover = [...input.branch]
			.reverse()
			.find(
				(entry): entry is Extract<SessionEntry, { type: "context_rollover" }> =>
					entry.type === "context_rollover" && entry.targetContextEpoch === input.contextEpoch,
			);
		if (previousRollover) {
			for (const id of collectNoteReferenceIds(previousRollover.bundle.note)) allowedSourceEntryIds.add(id);
		}
	}
	validateContextRolloverNote(input.output.checkpoint, input.branch, allowedSourceEntryIds);
	if (
		!input.output.checkpoint.objective.sourceEntryIds.some(
			(entryId) => createTaskScopeId(entryId) === input.taskNoteScope.taskScopeId,
		)
	) {
		throw new Error("invalid_evidence");
	}

	const events: TaskNoteEvent[] = [];
	let projection = input.taskNoteProjection;
	for (let candidateIndex = 0; candidateIndex < input.output.noteUpdateCandidates.length; candidateIndex++) {
		const candidate = input.output.noteUpdateCandidates[candidateIndex];
		const accepted = acceptTaskNoteCandidate(candidate, {
			scope: input.taskNoteScope,
			contextEpoch: input.contextEpoch,
			source: { type: "checkpoint", checkpointId: input.checkpointId, candidateIndex },
			branch: input.branch,
			projection,
			allowedEntryIds: allowedSourceEntryIds,
			eventCount: input.taskNoteEvents.length + events.length,
		});
		if (accepted.status !== "accepted") throw new Error(accepted.reason);
		events.push(accepted.event);
		const rebuilt = buildTaskNoteProjection({
			events: [...input.taskNoteEvents, ...events],
			scope: input.taskNoteScope,
		});
		if (rebuilt.status !== "valid") throw new Error(rebuilt.reason);
		projection = rebuilt.snapshot;
	}

	const checkpoint: ContextRolloverCheckpoint = {
		version: 1,
		checkpointId: input.checkpointId,
		promptGeneration: input.promptGeneration,
		contextEpoch: input.contextEpoch,
		coveredStartEntryId: covered[0].id,
		coveredEndEntryId: covered.at(-1)?.id ?? covered[0].id,
		coveredEntryIds: covered.map((entry) => entry.id),
		sourcePrefixFingerprint: fingerprintContextRolloverValue(covered),
		todoStateEntryId: input.todoStateEntryId,
		todoStateFingerprint: input.todoStateFingerprint,
		requestConfigFingerprint: input.requestConfigFingerprint,
		compactionPrefix: createPrefixCheckpointFromBoundary(
			[...input.branch],
			covered.at(-1)?.id ?? covered[0].id,
			JSON.stringify(input.output.checkpoint),
			input.usage,
		),
		note: structuredClone(input.output.checkpoint),
	};
	return {
		version: 1,
		checkpoint,
		taskNoteBatch: {
			version: 1,
			batchId: createTaskNoteBatchId(input.checkpointId, events),
			events,
		},
	};
}

function containsPotentialSecret(text: string): boolean {
	return (
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
		/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/.test(text) ||
		/\bAKIA[0-9A-Z]{16}\b/.test(text) ||
		/\b(?:xoxb|xoxp)-[A-Za-z0-9-]{20,}\b/.test(text) ||
		/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i.test(text) ||
		/\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*[^\s]{8,}/i.test(text)
	);
}

function isUserSource(entry: SessionEntry | undefined): boolean {
	return (
		(entry?.type === "message" && entry.message.role === "user") ||
		(entry?.type === "custom_message" && entry.customType === "user-provenance")
	);
}

export function fingerprintContextRolloverValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createContextRolloverDispatchId(rolloverId: string, preparedRequestFingerprint: string): string {
	return createHash("sha256")
		.update(`context-rollover-dispatch-v1${rolloverId}${preparedRequestFingerprint}`)
		.digest("hex");
}

export function formatContextRolloverHandoff(bundle: ContextRolloverBundle): string {
	return formatHandoff(bundle);
}

export function validatePreparedRolloverBudget(
	preparation: PreparedContinuation,
	sourceBudget: ContextBudget,
	sourceRequestFingerprint: string,
): ContextRolloverBlockedReason | undefined {
	if (preparation.budget.decision !== "fits") return "prepared_context_limit";
	if (preparation.budget.tokens > Math.floor(preparation.budget.contextWindow * 0.5)) {
		return "prepared_over_half_window";
	}
	if (preparation.requestFingerprint === sourceRequestFingerprint) return "unchanged_request";
	if (preparation.budget.tokens >= sourceBudget.tokens) return "prepared_context_limit";
	return undefined;
}

/**
 * Derive the Strong Progress credits available after a sequence of persisted evidence.
 * A verification only credits the effect immediately preceding it when that result was
 * not already observed before the effect. This keeps a write/read-back pair useful while
 * preventing an x -> y -> x rollback from minting a second credit for the old state.
 */
export function collectStrongProgressCreditIds(
	entries: readonly SessionEntry[],
	consumedCreditIds: ReadonlySet<string> = new Set(),
): string[] {
	const progressEntries = entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "context_progress" }> =>
			entry.type === "context_progress" && entry.outcome === "succeeded",
	);
	const credits: string[] = [];
	for (let index = 0; index < progressEntries.length; index++) {
		const entry = progressEntries[index];
		if (entry.evidenceKind === "task_completed") {
			if (!consumedCreditIds.has(entry.evidenceId)) credits.push(entry.evidenceId);
			continue;
		}
		if (entry.evidenceKind !== "verification") continue;

		let effectIndex = -1;
		for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
			const candidate = progressEntries[candidateIndex];
			if (candidate.evidenceKind === "non_read_effect" && candidate.targetFingerprint === entry.targetFingerprint) {
				effectIndex = candidateIndex;
				break;
			}
		}
		if (effectIndex < 0) continue;
		const effect = progressEntries[effectIndex];
		if (effect.resultFingerprint !== entry.resultFingerprint) continue;
		const stateWasObservedBefore = progressEntries
			.slice(0, effectIndex)
			.some(
				(candidate) =>
					candidate.evidenceKind === "non_read_effect" &&
					candidate.targetFingerprint === effect.targetFingerprint &&
					candidate.resultFingerprint === effect.resultFingerprint,
			);
		if (stateWasObservedBefore) continue;
		const creditId = fingerprintContextRolloverValue({
			kind: "verified_effect",
			effect: effect.evidenceId,
			verification: entry.evidenceId,
		});
		if (!consumedCreditIds.has(creditId)) credits.push(creditId);
	}
	return credits;
}
