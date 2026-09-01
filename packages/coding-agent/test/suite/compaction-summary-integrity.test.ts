import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionPreparation, compact } from "../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("memory-context-integrity: summary inheritance", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	function preparation(): CompactionPreparation {
		return {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [{ role: "user", content: "Implement the next step", timestamp: 1 }],
			previousSummary: "User constraint: never publish changes without approval.",
			isSplitTurn: true,
			tokensBefore: 10000,
			fileOps: { read: new Set(["design.md"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1000 },
		};
	}

	it("C01 retains previousSummary when only the turn prefix is new", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Prefix progress")]);
		const result = await compact(
			preparation(),
			harness.getModel(),
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamSimple,
		);
		expect(result.summary).toContain("never publish changes without approval");
		expect(result.summary).toContain("Prefix progress");
		expect(result.summary).not.toContain("No prior history");
		expect(result.details).toEqual({ readFiles: ["design.md"], modifiedFiles: [] });
	});

	it.each(["stop", "length", "aborted", "error"] as const)(
		"C05 rejects incomplete or empty summary (%s)",
		async (stopReason) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage(stopReason === "stop" ? "" : "Partial summary", { stopReason })]);
			await expect(
				compact(
					preparation(),
					harness.getModel(),
					"faux-key",
					undefined,
					undefined,
					undefined,
					undefined,
					streamSimple,
				),
			).rejects.toThrow();
		},
	);
});
