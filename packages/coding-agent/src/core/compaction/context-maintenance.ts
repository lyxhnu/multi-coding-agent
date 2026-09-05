import { createHash, randomUUID } from "node:crypto";
import { createProviderRequestFingerprint } from "@earendil-works/pi-agent-core";
import type { Context, ContextBudget, ContextBudgetOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

export type ContextMaintenanceState =
	| "idle"
	| "measuring"
	| "default_shake"
	| "soft_compaction"
	| "rescue_shake"
	| "superseded"
	| "ready"
	| "blocked"
	| "cancelled";

export interface ContextMaintenanceBudget {
	promptGeneration: number;
	contextEpoch: number;
	softCompactionOperationsStarted: number;
	rejectedRequestFingerprints: Set<string>;
	continuedRequestFingerprints: Set<string>;
	overflowRetriesUsed: number;
}

export type ContextMaintenanceCause = "budget_limit" | "provider_overflow" | "threshold";
export type ContextMaintenancePhase = "pre_prompt" | "mid_run" | "post_run";
export type ContinuationIntent = "required" | "forbidden";

export interface ContextMaintenanceTrigger {
	triggerId: string;
	cause: ContextMaintenanceCause;
	phase: ContextMaintenancePhase;
	continuation: ContinuationIntent;
	signal?: AbortSignal;
}

export interface ContextMaintenanceSnapshot {
	fingerprint: string;
	sourceFingerprint: string;
	budget: ContextBudget;
}

export type ReductionMethod = "default_shake" | "soft_compaction" | "rescue_shake";
export type ReductionUnavailableReason = "no_candidate" | "no_compactable_range" | "attempt_limit";
export type ReductionFailureReason =
	| "provider_failed"
	| "authorization_failed"
	| "wall_clock_exhausted"
	| "invalid_summary"
	| "extension_failed";
export type ReductionWarning = "extension_notification_failed" | "memory_archive_failed" | "ui_notification_failed";
export type BudgetVerification = "fits" | "still_limited" | "unknown" | "estimated_progress";
export type ContextMaintenanceBlockedReason =
	| "no_progress"
	| "methods_exhausted"
	| "attempt_limit"
	| "reduction_failed"
	| "verification_unknown"
	| "extension_veto"
	| "superseded";
export type ContextMaintenanceReasonCode =
	| ReductionUnavailableReason
	| ReductionFailureReason
	| ReductionWarning
	| ContextMaintenanceBlockedReason
	| "regressed";

export type ReductionAttemptResult =
	| {
			outcome: "committed";
			method: ReductionMethod;
			attemptIndex: number;
			requestFingerprint: string;
			tokensBefore: number;
			tokensAfter: number;
			budgetAfter: ContextBudget;
			verification: BudgetVerification;
			warnings: ReductionWarning[];
	  }
	| {
			outcome: "unavailable";
			method: ReductionMethod;
			attemptIndex: number;
			requestFingerprint: string;
			tokensBefore: number;
			reason: ReductionUnavailableReason;
	  }
	| {
			outcome: "failed";
			method: ReductionMethod;
			attemptIndex: number;
			requestFingerprint: string;
			tokensBefore: number;
			reason: ReductionFailureReason;
	  }
	| {
			outcome: "superseded";
			method: ReductionMethod;
			attemptIndex: number;
			requestFingerprint: string;
			currentFingerprint: string;
			tokensBefore: number;
	  }
	| {
			outcome: "vetoed";
			method: ReductionMethod;
			attemptIndex: number;
			requestFingerprint: string;
			tokensBefore: number;
			reason: "extension_veto";
	  }
	| {
			outcome: "cancelled";
			method: ReductionMethod;
			attemptIndex: number;
			requestFingerprint: string;
			tokensBefore: number;
	  };

export type ContextMaintenanceOutcome =
	| {
			outcome: "ready";
			changed: boolean;
			verification: "fits" | "not_required" | "estimated_progress";
			requestFingerprint: string;
			budget: ContextBudget;
			attempts: ReductionAttemptResult[];
	  }
	| {
			outcome: "blocked";
			requestFingerprint: string;
			budget: ContextBudget;
			reason: ContextMaintenanceBlockedReason;
			attempts: ReductionAttemptResult[];
	  }
	| {
			outcome: "cancelled";
			requestFingerprint: string;
			budget: ContextBudget;
			attempts: ReductionAttemptResult[];
	  };

export type ContextMaintenanceAction = "continue" | "wait" | "stop";

export interface ContextMaintenanceTransition {
	maintenanceId: string;
	state: ContextMaintenanceState;
	snapshot: ContextMaintenanceSnapshot;
	method?: ReductionMethod;
	attemptIndex?: number;
	attempt?: ReductionAttemptResult;
	verification?: "fits" | "not_required" | "estimated_progress";
	reasonCode?: ContextMaintenanceReasonCode;
}

export interface ContextMaintenanceDependencies {
	measure: () => Promise<ContextMaintenanceSnapshot>;
	defaultShake: (snapshot: ContextMaintenanceSnapshot, attemptIndex: number) => Promise<ReductionAttemptResult>;
	softCompaction: (snapshot: ContextMaintenanceSnapshot, attemptIndex: number) => Promise<ReductionAttemptResult>;
	rescueShake: (snapshot: ContextMaintenanceSnapshot, attemptIndex: number) => Promise<ReductionAttemptResult>;
	onTransition?: (transition: ContextMaintenanceTransition) => void;
	createMaintenanceId?: () => string;
}

const MAX_SOFT_COMPACTION_OPERATIONS = 3;

export function createContextMaintenanceBudget(
	promptGeneration: number,
	contextEpoch = 0,
	usage: { softCompaction: number; overflowRetry: number } = { softCompaction: 0, overflowRetry: 0 },
): ContextMaintenanceBudget {
	return {
		promptGeneration,
		contextEpoch,
		softCompactionOperationsStarted: usage.softCompaction,
		rejectedRequestFingerprints: new Set(),
		continuedRequestFingerprints: new Set(),
		overflowRetriesUsed: usage.overflowRetry,
	};
}

export function createContextMaintenanceRequestFingerprint(
	context: Context,
	model: Model<Api>,
	options: ContextBudgetOptions = {},
	reasoning?: SimpleStreamOptions["reasoning"],
): string {
	return createProviderRequestFingerprint(context, model, { reasoning, budget: options });
}

export function createContextMaintenanceSourceFingerprint(entries: readonly unknown[]): string {
	const sourceEntryTypes = new Set([
		"message",
		"custom_message",
		"compaction",
		"branch_summary",
		"shake",
		"model_change",
		"thinking_level_change",
		"delivery_receipt",
		"context_rollover",
		"context_rollover_dispatch",
	]);
	const effectiveEntries = entries.filter(
		(entry) =>
			typeof entry !== "object" || entry === null || !("type" in entry) || sourceEntryTypes.has(String(entry.type)),
	);
	return createHash("sha256").update(JSON.stringify(effectiveEntries)).digest("hex");
}

export function resolveContextMaintenanceAction(
	outcome: ContextMaintenanceOutcome,
	continuation: ContinuationIntent,
): ContextMaintenanceAction {
	if (outcome.outcome !== "ready") return "stop";
	return continuation === "required" ? "continue" : "wait";
}

function verificationForBudget(budget: ContextBudget): BudgetVerification {
	if (budget.decision === "fits") return "fits";
	if (budget.decision === "context_limit") return "still_limited";
	return "unknown";
}

export async function runContextMaintenance(
	trigger: ContextMaintenanceTrigger,
	promptBudget: ContextMaintenanceBudget,
	dependencies: ContextMaintenanceDependencies,
): Promise<ContextMaintenanceOutcome> {
	const maintenanceId = dependencies.createMaintenanceId?.() ?? randomUUID();
	const attempts: ReductionAttemptResult[] = [];
	let changed = false;
	let supersededCount = 0;
	let attemptIndex = 0;
	let snapshot = await dependencies.measure();

	const transition = (
		state: ContextMaintenanceState,
		method?: ReductionMethod,
		attempt?: ReductionAttemptResult,
		reasonCode?: ContextMaintenanceReasonCode,
		verification?: "fits" | "not_required" | "estimated_progress",
	): void =>
		dependencies.onTransition?.({
			maintenanceId,
			state,
			snapshot,
			method,
			...(method === undefined ? {} : { attemptIndex: attempt?.attemptIndex ?? attemptIndex }),
			attempt,
			reasonCode,
			verification,
		});

	const cancelled = (): ContextMaintenanceOutcome => {
		transition("cancelled");
		return {
			outcome: "cancelled",
			requestFingerprint: snapshot.fingerprint,
			budget: snapshot.budget,
			attempts,
		};
	};
	const blocked = (reason: ContextMaintenanceBlockedReason): ContextMaintenanceOutcome => {
		transition("blocked", undefined, undefined, reason);
		return {
			outcome: "blocked",
			requestFingerprint: snapshot.fingerprint,
			budget: snapshot.budget,
			reason,
			attempts,
		};
	};
	const ready = (verification: "fits" | "not_required" | "estimated_progress"): ContextMaintenanceOutcome => {
		if (trigger.continuation === "required" && promptBudget.rejectedRequestFingerprints.has(snapshot.fingerprint)) {
			return blocked("no_progress");
		}
		transition("ready", undefined, undefined, undefined, verification);
		return {
			outcome: "ready",
			changed,
			verification,
			requestFingerprint: snapshot.fingerprint,
			budget: snapshot.budget,
			attempts,
		};
	};

	transition("measuring");
	if (trigger.signal?.aborted) return cancelled();
	if (trigger.cause !== "provider_overflow") {
		if (snapshot.budget.decision === "fits") return ready("not_required");
		if (snapshot.budget.decision === "unknown") return blocked("verification_unknown");
	}
	if (trigger.cause === "provider_overflow" && promptBudget.overflowRetriesUsed > 0) {
		return blocked("attempt_limit");
	}

	let method: ReductionMethod = "default_shake";
	while (true) {
		if (trigger.signal?.aborted) return cancelled();
		if (method === "soft_compaction") {
			if (promptBudget.softCompactionOperationsStarted >= MAX_SOFT_COMPACTION_OPERATIONS) {
				method = "rescue_shake";
				continue;
			}
			promptBudget.softCompactionOperationsStarted++;
		}

		attemptIndex++;
		transition(method, method);
		const attempt = await dependencies[
			method === "default_shake" ? "defaultShake" : method === "soft_compaction" ? "softCompaction" : "rescueShake"
		](snapshot, attemptIndex);
		attempts.push(attempt);

		if (attempt.outcome === "cancelled") {
			transition(method, method, attempt);
			return cancelled();
		}
		if (attempt.outcome === "vetoed") {
			transition(method, method, attempt, attempt.reason);
			return blocked("extension_veto");
		}
		if (attempt.outcome === "superseded") {
			transition("superseded", method, attempt);
			if (supersededCount >= 1) return blocked("superseded");
			supersededCount++;
			snapshot = await dependencies.measure();
			transition("measuring");
			if (trigger.signal?.aborted) return cancelled();
			if (trigger.cause !== "provider_overflow" && snapshot.budget.decision !== "context_limit") {
				return ready("not_required");
			}
			method = "default_shake";
			continue;
		}

		if (attempt.outcome === "committed") {
			changed = true;
			snapshot = await dependencies.measure();
			const verifiedAttempt: ReductionAttemptResult = {
				...attempt,
				tokensAfter: snapshot.budget.tokens,
				budgetAfter: snapshot.budget,
				verification: verificationForBudget(snapshot.budget),
			};
			attempts[attempts.length - 1] = verifiedAttempt;
			transition(
				method,
				method,
				verifiedAttempt,
				snapshot.budget.tokens > attempt.tokensBefore ? "regressed" : verifiedAttempt.warnings[0],
			);

			if (snapshot.budget.tokens >= attempt.tokensBefore) return blocked("no_progress");
			if (snapshot.budget.decision === "fits") return ready("fits");
			if (snapshot.budget.decision === "unknown") {
				if (
					trigger.cause === "provider_overflow" &&
					promptBudget.overflowRetriesUsed === 0 &&
					snapshot.fingerprint !== attempt.requestFingerprint
				) {
					return ready("estimated_progress");
				}
				return blocked("verification_unknown");
			}
		} else {
			transition(
				method,
				method,
				attempt,
				attempt.outcome === "failed" || attempt.outcome === "unavailable" ? attempt.reason : undefined,
			);
		}

		if (method === "default_shake") {
			method = "soft_compaction";
			continue;
		}
		if (method === "soft_compaction" && attempt.outcome === "committed") {
			method = "soft_compaction";
			continue;
		}
		if (method === "soft_compaction") {
			method = "rescue_shake";
			continue;
		}
		return blocked("methods_exhausted");
	}
}
