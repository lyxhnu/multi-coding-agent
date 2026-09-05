import type { ContextBudget } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	collectStrongProgressCreditIds,
	fingerprintContextRolloverValue,
	shouldStartContextRollover,
	validatePreparedRolloverBudget,
} from "../../src/core/context-rollover.ts";
import type { ContextProgressEntry } from "../../src/core/session-manager.ts";

function budget(tokens: number, decision: ContextBudget["decision"] = "context_limit"): ContextBudget {
	return {
		tokens,
		usageTokens: tokens,
		trailingTokens: 0,
		lastUsageIndex: 0,
		contextWindow: 100,
		modelMaxOutputTokens: 10,
		requestedMaxOutputTokens: 10,
		unknownFields: [],
		outputReserveTokens: 10,
		safetyTokens: 0,
		availableOutputTokens: Math.max(0, 100 - tokens),
		decision,
	};
}

describe("Context Rollover policy", () => {
	it.each([
		["budget_limit", "methods_exhausted"],
		["budget_limit", "no_progress"],
		["provider_overflow", "attempt_limit"],
	] as const)("TG01-TG03 starts for %s + %s", (cause, reason) => {
		expect(
			shouldStartContextRollover({
				maintenance: {
					outcome: "blocked",
					requestFingerprint: "source",
					budget: budget(90),
					reason,
					attempts: [],
				},
				cause,
				continuation: "required",
				taskIsIncomplete: true,
			}),
		).toBe(true);
	});

	it("TG04-TG09 rejects non-terminal, forbidden and complete work", () => {
		const blocked = {
			outcome: "blocked" as const,
			requestFingerprint: "source",
			budget: budget(90),
			reason: "methods_exhausted" as const,
			attempts: [],
		};
		expect(
			shouldStartContextRollover({
				maintenance: blocked,
				cause: "threshold",
				continuation: "required",
				taskIsIncomplete: true,
			}),
		).toBe(false);
		expect(
			shouldStartContextRollover({
				maintenance: blocked,
				cause: "budget_limit",
				continuation: "forbidden",
				taskIsIncomplete: true,
			}),
		).toBe(false);
		expect(
			shouldStartContextRollover({
				maintenance: blocked,
				cause: "budget_limit",
				continuation: "required",
				taskIsIncomplete: false,
			}),
		).toBe(false);
	});

	it("HB11-HB13 enforces the prepared request budget and fingerprint gates", () => {
		const source = budget(90);
		const preparation = {
			preparationId: "preparation-1",
			baseContextFingerprint: "base",
			requestFingerprint: "prepared",
			budget: budget(40, "fits"),
			queueRevision: "queue",
			reservedQueueItemIds: [],
		};
		expect(validatePreparedRolloverBudget(preparation, source, "source")).toBeUndefined();
		expect(validatePreparedRolloverBudget({ ...preparation, budget: budget(51, "fits") }, source, "source")).toBe(
			"prepared_over_half_window",
		);
		expect(validatePreparedRolloverBudget({ ...preparation, requestFingerprint: "source" }, source, "source")).toBe(
			"unchanged_request",
		);
	});

	it("PG07/PG14 credits a verified effect exactly once", () => {
		const entries: ContextProgressEntry[] = [
			{
				type: "context_progress",
				id: "effect-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				evidenceId: "effect-1",
				evidenceKind: "non_read_effect",
				targetFingerprint: "file-a",
				resultFingerprint: "state-y",
				outcome: "succeeded",
			},
			{
				type: "context_progress",
				id: "verification-1",
				parentId: "effect-1",
				timestamp: "2026-01-01T00:00:01.000Z",
				evidenceId: "verification-1",
				evidenceKind: "verification",
				targetFingerprint: "file-a",
				resultFingerprint: "state-y",
				outcome: "succeeded",
			},
		];
		const [credit] = collectStrongProgressCreditIds(entries);
		expect(credit).toBe(
			fingerprintContextRolloverValue({
				kind: "verified_effect",
				effect: "effect-1",
				verification: "verification-1",
			}),
		);
		expect(collectStrongProgressCreditIds(entries, new Set([credit]))).toEqual([]);
	});

	it("PG05 does not mint a credit when an effect returns to an observed state", () => {
		const makeEntry = (
			id: string,
			evidenceKind: ContextProgressEntry["evidenceKind"],
			resultFingerprint: string,
		): ContextProgressEntry => ({
			type: "context_progress",
			id,
			parentId: null,
			timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
			evidenceId: id,
			evidenceKind,
			targetFingerprint: "file-a",
			resultFingerprint,
			outcome: "succeeded",
		});
		const entries = [
			makeEntry("effect-x", "non_read_effect", "state-x"),
			makeEntry("verification-x", "verification", "state-x"),
			makeEntry("effect-y", "non_read_effect", "state-y"),
			makeEntry("verification-y", "verification", "state-y"),
			makeEntry("effect-x-again", "non_read_effect", "state-x"),
			makeEntry("verification-x-again", "verification", "state-x"),
		];
		expect(collectStrongProgressCreditIds(entries)).toHaveLength(2);
	});
});
