import { evaluateContextBudget } from "@earendil-works/pi-ai";

export { OUTPUT_HEADROOM_FACTOR, OUTPUT_HEADROOM_MAX_TOKENS } from "@earendil-works/pi-ai";

/**
 * Grok-aligned compaction policy, layered on top of pi's existing token
 * budget settings (`reserveTokens`/`keepRecentTokens` in
 * `../settings-manager.ts`). Mirrors Grok Build's `CompactionPolicy`
 * (see xai-grok-agent/src/compaction.rs): same field names/semantics, same
 * defaults.
 *
 * Pure policy calculations; AgentSession owns model selection, deadlines and execution.
 */

export interface CompactionPolicy {
	/** Percentage of the context window that triggers auto-compaction (e.g. 85 = compact at 85% full). */
	autoCompactThresholdPercent: number;
	/** Model id to use for the compaction summary. Undefined = use the session's current model. */
	compactModel?: string;
	/** Whether to archive the successfully committed automatic summary into project memory. */
	memoryFlushEnabled: boolean;
	/** Per-compaction wall-clock budget in seconds; a generation exceeding it should be cut and retried. */
	wallClockBudgetSecs: number;
	/** Speculative two-pass compaction (background prefix summary + tail summary at compaction time). */
	twoPassEnabled: boolean;
	/** When true, an unresolvable `compactModel` fails the compaction attempt instead of silently falling back to the session's current model. Default false. */
	strictCompactModel: boolean;
}

export interface CompactionPolicySettings {
	autoCompactThresholdPercent?: number;
	compactModel?: string;
	memoryFlushEnabled?: boolean;
	wallClockBudgetSecs?: number;
	twoPassEnabled?: boolean;
	strictCompactModel?: boolean;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	autoCompactThresholdPercent: 85,
	compactModel: undefined,
	memoryFlushEnabled: false,
	wallClockBudgetSecs: 300,
	twoPassEnabled: false,
	strictCompactModel: false,
};

/** Two-pass compaction speculatively prefires this many percentage points before the real threshold. */
export const TWO_PASS_PREFIRE_MARGIN_PERCENT = 10;

export function resolveCompactionPolicy(settings: CompactionPolicySettings | undefined): CompactionPolicy {
	return {
		autoCompactThresholdPercent:
			settings?.autoCompactThresholdPercent ?? DEFAULT_COMPACTION_POLICY.autoCompactThresholdPercent,
		compactModel: settings?.compactModel ?? DEFAULT_COMPACTION_POLICY.compactModel,
		memoryFlushEnabled: settings?.memoryFlushEnabled ?? DEFAULT_COMPACTION_POLICY.memoryFlushEnabled,
		wallClockBudgetSecs: settings?.wallClockBudgetSecs ?? DEFAULT_COMPACTION_POLICY.wallClockBudgetSecs,
		twoPassEnabled: settings?.twoPassEnabled ?? DEFAULT_COMPACTION_POLICY.twoPassEnabled,
		strictCompactModel: settings?.strictCompactModel ?? DEFAULT_COMPACTION_POLICY.strictCompactModel,
	};
}

export interface CompactionEntryDetails {
	policy: CompactionPolicy;
	mode: "single-pass" | "two-pass";
}

/** Percentage of context window used, given current and max tokens. Clamped to [0, 100]. */
export function usagePercent(usedTokens: number, contextWindow: number): number {
	if (contextWindow <= 0) return 0;
	return Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100));
}

/** True once usage crosses the policy's auto-compact threshold. */
export function shouldAutoCompact(usedTokens: number, contextWindow: number, policy: CompactionPolicy): boolean {
	return usagePercent(usedTokens, contextWindow) >= policy.autoCompactThresholdPercent;
}

/** Shares the same decision and safety margin as the final request preflight. */
export function needsRoomForOutput(
	usedTokens: number,
	contextWindow: number,
	maxTokens: number,
	policy: CompactionPolicy,
): boolean {
	return (
		evaluateContextBudget(
			{ tokens: usedTokens, usageTokens: 0, trailingTokens: usedTokens, lastUsageIndex: null },
			{ contextWindow, maxTokens },
			{ thresholdPercent: policy.autoCompactThresholdPercent },
		).decision === "context_limit"
	);
}

/**
 * True once usage crosses the speculative two-pass prefire point (threshold
 * minus a fixed margin), but hasn't reached the real threshold yet. Only
 * meaningful when `policy.twoPassEnabled`.
 */
export function shouldPrefireTwoPass(usedTokens: number, contextWindow: number, policy: CompactionPolicy): boolean {
	if (!policy.twoPassEnabled) return false;
	const percent = usagePercent(usedTokens, contextWindow);
	const prefireAt = Math.max(0, policy.autoCompactThresholdPercent - TWO_PASS_PREFIRE_MARGIN_PERCENT);
	return percent >= prefireAt && percent < policy.autoCompactThresholdPercent;
}

/**
 * Compose an AbortSignal that also aborts once `budgetSecs` elapses, without
 * mutating or leaking listeners on `baseSignal`. Callers must eventually stop
 * using the returned signal (e.g. once the guarded operation settles) so the
 * internal timer can be cleared — call the returned `dispose()`.
 */
export function createWallClockBudgetSignal(
	baseSignal: AbortSignal | undefined,
	budgetSecs: number,
): { signal: AbortSignal; dispose: () => void } {
	if (budgetSecs <= 0) {
		return { signal: baseSignal ?? new AbortController().signal, dispose: () => {} };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), budgetSecs * 1000);

	const onBaseAbort = () => controller.abort();
	if (baseSignal) {
		if (baseSignal.aborted) controller.abort();
		else baseSignal.addEventListener("abort", onBaseAbort, { once: true });
	}

	const dispose = () => {
		clearTimeout(timer);
		baseSignal?.removeEventListener("abort", onBaseAbort);
	};

	return { signal: controller.signal, dispose };
}
