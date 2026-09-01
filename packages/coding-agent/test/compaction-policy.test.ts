import { describe, expect, it, vi } from "vitest";
import {
	createWallClockBudgetSignal,
	DEFAULT_COMPACTION_POLICY,
	resolveCompactionPolicy,
	shouldAutoCompact,
	shouldPrefireTwoPass,
	usagePercent,
} from "../src/core/compaction/compaction-policy.ts";

describe("resolveCompactionPolicy", () => {
	it("matches the Grok-aligned defaults when no settings are provided", () => {
		expect(resolveCompactionPolicy(undefined)).toEqual(DEFAULT_COMPACTION_POLICY);
	});

	it("overrides individual fields while keeping the rest at their defaults", () => {
		const policy = resolveCompactionPolicy({ autoCompactThresholdPercent: 90, compactModel: "openai/gpt-5-mini" });
		expect(policy.autoCompactThresholdPercent).toBe(90);
		expect(policy.compactModel).toBe("openai/gpt-5-mini");
		expect(policy.wallClockBudgetSecs).toBe(DEFAULT_COMPACTION_POLICY.wallClockBudgetSecs);
	});
});

describe("usagePercent", () => {
	it("computes a simple percentage", () => {
		expect(usagePercent(50_000, 100_000)).toBe(50);
	});

	it("clamps to 100 when usage exceeds the window", () => {
		expect(usagePercent(150_000, 100_000)).toBe(100);
	});

	it("returns 0 for a non-positive context window", () => {
		expect(usagePercent(1000, 0)).toBe(0);
	});
});

describe("shouldAutoCompact", () => {
	it("is false below the threshold", () => {
		expect(shouldAutoCompact(80_000, 100_000, DEFAULT_COMPACTION_POLICY)).toBe(false);
	});

	it("is true at or above the threshold (default 85%)", () => {
		expect(shouldAutoCompact(85_000, 100_000, DEFAULT_COMPACTION_POLICY)).toBe(true);
		expect(shouldAutoCompact(90_000, 100_000, DEFAULT_COMPACTION_POLICY)).toBe(true);
	});
});

describe("shouldPrefireTwoPass", () => {
	it("is always false when two-pass compaction is disabled", () => {
		expect(shouldPrefireTwoPass(80_000, 100_000, DEFAULT_COMPACTION_POLICY)).toBe(false);
	});

	it("fires within the margin window before the real threshold, once enabled", () => {
		const policy = { ...DEFAULT_COMPACTION_POLICY, twoPassEnabled: true };
		expect(shouldPrefireTwoPass(76_000, 100_000, policy)).toBe(true); // 76% is within [75, 85)
		expect(shouldPrefireTwoPass(70_000, 100_000, policy)).toBe(false); // below the margin window
		expect(shouldPrefireTwoPass(90_000, 100_000, policy)).toBe(false); // past the real threshold already
	});
});

describe("createWallClockBudgetSignal", () => {
	it("aborts on its own after the budget elapses", () => {
		vi.useFakeTimers();
		try {
			const { signal, dispose } = createWallClockBudgetSignal(undefined, 300);
			expect(signal.aborted).toBe(false);
			vi.advanceTimersByTime(300_000);
			expect(signal.aborted).toBe(true);
			dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("propagates abort from the base signal", () => {
		const base = new AbortController();
		const { signal, dispose } = createWallClockBudgetSignal(base.signal, 300);
		expect(signal.aborted).toBe(false);
		base.abort();
		expect(signal.aborted).toBe(true);
		dispose();
	});

	it("is already aborted when the base signal is already aborted", () => {
		const base = new AbortController();
		base.abort();
		const { signal, dispose } = createWallClockBudgetSignal(base.signal, 300);
		expect(signal.aborted).toBe(true);
		dispose();
	});

	it("dispose() prevents the budget timer from firing later", () => {
		vi.useFakeTimers();
		try {
			const { signal, dispose } = createWallClockBudgetSignal(undefined, 300);
			dispose();
			vi.advanceTimersByTime(300_000);
			expect(signal.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
