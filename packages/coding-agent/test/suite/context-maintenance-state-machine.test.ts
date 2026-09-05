import type { ContextBudget } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type ContextMaintenanceDependencies,
	type ContextMaintenanceSnapshot,
	createContextMaintenanceBudget,
	createContextMaintenanceSourceFingerprint,
	type ReductionAttemptResult,
	type ReductionMethod,
	resolveContextMaintenanceAction,
	runContextMaintenance,
} from "../../src/core/compaction/context-maintenance.ts";

function budget(tokens: number, decision: ContextBudget["decision"]): ContextBudget {
	return {
		tokens,
		usageTokens: 0,
		trailingTokens: tokens,
		lastUsageIndex: null,
		contextWindow: 100,
		modelMaxOutputTokens: 10,
		requestedMaxOutputTokens: 10,
		unknownFields: decision === "unknown" ? ["contextWindow"] : [],
		outputReserveTokens: 10,
		safetyTokens: 0,
		availableOutputTokens: decision === "unknown" ? null : Math.max(0, 100 - tokens),
		decision,
	};
}

function snapshot(name: string, tokens: number, decision: ContextBudget["decision"]): ContextMaintenanceSnapshot {
	return { fingerprint: `request-${name}`, sourceFingerprint: `source-${name}`, budget: budget(tokens, decision) };
}

function unavailable(
	method: ReductionMethod,
	snapshotValue: ContextMaintenanceSnapshot,
	attemptIndex: number,
): ReductionAttemptResult {
	return {
		outcome: "unavailable",
		method,
		attemptIndex,
		requestFingerprint: snapshotValue.fingerprint,
		tokensBefore: snapshotValue.budget.tokens,
		reason: "no_candidate",
	};
}

function committed(
	method: ReductionMethod,
	snapshotValue: ContextMaintenanceSnapshot,
	attemptIndex: number,
	tokensAfter: number,
): ReductionAttemptResult {
	return {
		outcome: "committed",
		method,
		attemptIndex,
		requestFingerprint: snapshotValue.fingerprint,
		tokensBefore: snapshotValue.budget.tokens,
		tokensAfter,
		budgetAfter: budget(tokensAfter, tokensAfter < 90 ? "fits" : "context_limit"),
		verification: tokensAfter < 90 ? "fits" : "still_limited",
		warnings: [],
	};
}

function dependencies(
	snapshots: ContextMaintenanceSnapshot[],
	overrides: Partial<ContextMaintenanceDependencies> = {},
): ContextMaintenanceDependencies {
	let measureIndex = 0;
	return {
		measure: vi.fn(async () => snapshots[Math.min(measureIndex++, snapshots.length - 1)]),
		defaultShake: vi.fn(async (value, index) => unavailable("default_shake", value, index)),
		softCompaction: vi.fn(async (value, index) => unavailable("soft_compaction", value, index)),
		rescueShake: vi.fn(async (value, index) => unavailable("rescue_shake", value, index)),
		createMaintenanceId: () => "maintenance-1",
		...overrides,
	};
}

const requiredTrigger = {
	triggerId: "trigger-1",
	cause: "budget_limit",
	phase: "mid_run",
	continuation: "required",
} as const;

describe("context maintenance state machine", () => {
	it("excludes trace-only entries from the source fingerprint", () => {
		const message = { type: "message", id: "message-1", message: { role: "user", content: "hello" } };
		const trace = { type: "trace", id: "trace-1", event: { type: "context/maintenance", data: {} } };
		const logOnly = [
			{ type: "custom", id: "custom-1", customType: "checkpoint", data: {} },
			{ type: "label", id: "label-1", targetId: "message-1", label: "bookmark" },
			{ type: "session_info", id: "session-info-1", name: "renamed" },
		];

		expect(createContextMaintenanceSourceFingerprint([message, trace, ...logOnly])).toBe(
			createContextMaintenanceSourceFingerprint([message]),
		);
		expect(createContextMaintenanceSourceFingerprint([message, { ...message, id: "message-2" }])).not.toBe(
			createContextMaintenanceSourceFingerprint([message]),
		);
	});

	it("returns not_required without invoking a reduction when the request fits", async () => {
		const deps = dependencies([snapshot("fits", 40, "fits")]);
		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
		expect(outcome).toMatchObject({ outcome: "ready", changed: false, verification: "not_required" });
		expect(deps.defaultShake).not.toHaveBeenCalled();
	});

	it("does not resubmit a request fingerprint already rejected in the current prompt", async () => {
		const rejected = snapshot("rejected", 40, "fits");
		const deps = dependencies([rejected]);
		const promptBudget = createContextMaintenanceBudget(1);
		promptBudget.rejectedRequestFingerprints.add(rejected.fingerprint);

		const outcome = await runContextMaintenance(requiredTrigger, promptBudget, deps);

		expect(outcome).toMatchObject({ outcome: "blocked", reason: "no_progress" });
		expect(deps.defaultShake).not.toHaveBeenCalled();
	});

	it("stops after a successful default shake", async () => {
		const before = snapshot("before", 100, "context_limit");
		const after = snapshot("after", 70, "fits");
		const deps = dependencies([before, after], {
			defaultShake: vi.fn(async (value, index) => committed("default_shake", value, index, 70)),
		});
		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
		expect(outcome).toMatchObject({ outcome: "ready", changed: true, verification: "fits" });
		expect(deps.softCompaction).not.toHaveBeenCalled();
	});

	it("advances from unavailable shake to compaction and verifies the rebuilt request", async () => {
		const before = snapshot("before", 100, "context_limit");
		const after = snapshot("after", 60, "fits");
		const deps = dependencies([before, after], {
			softCompaction: vi.fn(async (value, index) => committed("soft_compaction", value, index, 60)),
		});
		const promptBudget = createContextMaintenanceBudget(1);
		const outcome = await runContextMaintenance(requiredTrigger, promptBudget, deps);
		expect(outcome).toMatchObject({ outcome: "ready", changed: true, requestFingerprint: "request-after" });
		expect(promptBudget.softCompactionOperationsStarted).toBe(1);
	});

	it("blocks immediately when a committed method makes no progress or regresses", async () => {
		for (const afterTokens of [100, 110]) {
			const before = snapshot("before", 100, "context_limit");
			const after = snapshot(`after-${afterTokens}`, afterTokens, "context_limit");
			const deps = dependencies([before, after], {
				defaultShake: vi.fn(async (value, index) => committed("default_shake", value, index, afterTokens)),
			});
			const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
			expect(outcome).toMatchObject({ outcome: "blocked", reason: "no_progress" });
			expect(deps.softCompaction).not.toHaveBeenCalled();
		}
	});

	it("uses at most three shared soft-compaction operations before rescue", async () => {
		const snapshots = [
			snapshot("0", 120, "context_limit"),
			snapshot("1", 115, "context_limit"),
			snapshot("2", 110, "context_limit"),
			snapshot("3", 105, "context_limit"),
			snapshot("4", 80, "fits"),
		];
		const deps = dependencies(snapshots, {
			softCompaction: vi.fn(async (value, index) =>
				committed("soft_compaction", value, index, value.budget.tokens - 5),
			),
			rescueShake: vi.fn(async (value, index) => committed("rescue_shake", value, index, 80)),
		});
		const promptBudget = createContextMaintenanceBudget(1);
		const outcome = await runContextMaintenance(requiredTrigger, promptBudget, deps);
		expect(outcome.outcome).toBe("ready");
		expect(deps.softCompaction).toHaveBeenCalledTimes(3);
		expect(deps.rescueShake).toHaveBeenCalledTimes(1);
		expect(promptBudget.softCompactionOperationsStarted).toBe(3);
	});

	it("shares the operation cap across maintenance runs", async () => {
		const promptBudget = createContextMaintenanceBudget(1);
		promptBudget.softCompactionOperationsStarted = 3;
		const before = snapshot("before", 100, "context_limit");
		const deps = dependencies([before]);
		const outcome = await runContextMaintenance(requiredTrigger, promptBudget, deps);
		expect(deps.softCompaction).not.toHaveBeenCalled();
		expect(deps.rescueShake).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ outcome: "blocked", reason: "methods_exhausted" });
	});

	it("moves to rescue after an uncommitted compaction failure", async () => {
		const before = snapshot("before", 100, "context_limit");
		const deps = dependencies([before], {
			softCompaction: vi.fn(
				async (value, index) =>
					({
						outcome: "failed",
						method: "soft_compaction",
						attemptIndex: index,
						requestFingerprint: value.fingerprint,
						tokensBefore: value.budget.tokens,
						reason: "provider_failed",
					}) satisfies ReductionAttemptResult,
			),
		});
		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
		expect(deps.rescueShake).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ outcome: "blocked", reason: "methods_exhausted" });
	});

	it("forces reduction for provider overflow even when local measurement fits or is unknown", async () => {
		for (const decision of ["fits", "unknown"] as const) {
			const before = snapshot(`before-${decision}`, 80, decision);
			const after = snapshot(`after-${decision}`, 70, "fits");
			const deps = dependencies([before, after], {
				defaultShake: vi.fn(async (value, index) => committed("default_shake", value, index, 70)),
			});
			const outcome = await runContextMaintenance(
				{ ...requiredTrigger, cause: "provider_overflow" },
				createContextMaintenanceBudget(1),
				deps,
			);
			expect(deps.defaultShake).toHaveBeenCalledTimes(1);
			expect(outcome.outcome).toBe("ready");
		}
	});

	it("allows one explicitly estimated overflow retry after verified progress", async () => {
		const before = snapshot("before", 80, "unknown");
		const after = snapshot("after", 70, "unknown");
		const deps = dependencies([before, after], {
			defaultShake: vi.fn(async (value, index) => committed("default_shake", value, index, 70)),
		});
		const outcome = await runContextMaintenance(
			{ ...requiredTrigger, cause: "provider_overflow" },
			createContextMaintenanceBudget(1),
			deps,
		);
		expect(outcome).toMatchObject({ outcome: "ready", verification: "estimated_progress" });
	});

	it("does not claim safety when post-reduction verification is unknown outside overflow", async () => {
		const before = snapshot("before", 100, "context_limit");
		const after = snapshot("after", 80, "unknown");
		const deps = dependencies([before, after], {
			defaultShake: vi.fn(async (value, index) => committed("default_shake", value, index, 80)),
		});
		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
		expect(outcome).toMatchObject({ outcome: "blocked", reason: "verification_unknown" });
	});

	it("fails closed when the initial non-overflow budget is unknown", async () => {
		const deps = dependencies([snapshot("unknown", 80, "unknown")]);

		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);

		expect(outcome).toMatchObject({ outcome: "blocked", reason: "verification_unknown" });
		expect(deps.defaultShake).not.toHaveBeenCalled();
		expect(deps.softCompaction).not.toHaveBeenCalled();
		expect(deps.rescueShake).not.toHaveBeenCalled();
	});

	it("remeasures one superseded source and bounds a second supersede", async () => {
		const first = snapshot("first", 100, "context_limit");
		const second = snapshot("second", 95, "context_limit");
		const deps = dependencies([first, second], {
			defaultShake: vi.fn(
				async (value, index) =>
					({
						outcome: "superseded",
						method: "default_shake",
						attemptIndex: index,
						requestFingerprint: value.fingerprint,
						currentFingerprint: `${value.sourceFingerprint}-new`,
						tokensBefore: value.budget.tokens,
					}) satisfies ReductionAttemptResult,
			),
		});
		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
		expect(deps.defaultShake).toHaveBeenCalledTimes(2);
		expect(deps.softCompaction).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ outcome: "blocked", reason: "superseded" });
	});

	it("does not claim a superseded request fits when the replacement budget is unknown", async () => {
		const first = snapshot("first", 100, "context_limit");
		const replacement = snapshot("replacement", 80, "unknown");
		const deps = dependencies([first, replacement], {
			defaultShake: vi.fn(
				async (value, index) =>
					({
						outcome: "superseded",
						method: "default_shake",
						attemptIndex: index,
						requestFingerprint: value.fingerprint,
						currentFingerprint: replacement.sourceFingerprint,
						tokensBefore: value.budget.tokens,
					}) satisfies ReductionAttemptResult,
			),
		});

		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);

		expect(outcome).toMatchObject({ outcome: "ready", changed: false, verification: "not_required" });
	});

	it("stops on cancellation and extension veto", async () => {
		const before = snapshot("before", 100, "context_limit");
		const cancelledDeps = dependencies([before], {
			defaultShake: vi.fn(
				async (value, index) =>
					({
						outcome: "cancelled",
						method: "default_shake",
						attemptIndex: index,
						requestFingerprint: value.fingerprint,
						tokensBefore: value.budget.tokens,
					}) satisfies ReductionAttemptResult,
			),
		});
		expect(
			await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), cancelledDeps),
		).toMatchObject({ outcome: "cancelled" });

		const vetoDeps = dependencies([before], {
			softCompaction: vi.fn(
				async (value, index) =>
					({
						outcome: "vetoed",
						method: "soft_compaction",
						attemptIndex: index,
						requestFingerprint: value.fingerprint,
						tokensBefore: value.budget.tokens,
						reason: "extension_veto",
					}) satisfies ReductionAttemptResult,
			),
		});
		expect(await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), vetoDeps)).toMatchObject({
			outcome: "blocked",
			reason: "extension_veto",
		});
		expect(vetoDeps.rescueShake).not.toHaveBeenCalled();
	});

	it("derives continuation independently from the shared outcome", async () => {
		const deps = dependencies([snapshot("fits", 40, "fits")]);
		const outcome = await runContextMaintenance(requiredTrigger, createContextMaintenanceBudget(1), deps);
		expect(resolveContextMaintenanceAction(outcome, "required")).toBe("continue");
		expect(resolveContextMaintenanceAction(outcome, "forbidden")).toBe("wait");
	});
});
