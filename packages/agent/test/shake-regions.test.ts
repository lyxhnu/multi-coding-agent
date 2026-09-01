import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/harness/compaction/compaction.ts";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	collectShakeRegions,
	DEFAULT_SHAKE_CONFIG,
	RESCUE_SHAKE_CONFIG,
	resolveShakeConfig,
	type ShakeCandidateEntry,
	type ShakeConfig,
	type ShakenIndex,
	WHOLE_TOOL_RESULT,
} from "../src/harness/compaction/shake.ts";

const NO_SHAKEN: ShakenIndex = new Map();

/** Text of roughly `tokens` estimated tokens (the heuristic is chars/4). */
function textOfTokens(tokens: number): string {
	return "x".repeat(tokens * 4);
}

function toolResultEntry(id: string, toolName: string, text: string): ShakeCandidateEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: `call-${id}`,
		toolName,
		isError: false,
		timestamp: 0,
	} as ToolResultMessage;
	return { type: "message", id, message };
}

function userEntry(id: string, text: string): ShakeCandidateEntry {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } as never };
}

function assistantEntry(id: string, text: string): ShakeCandidateEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as never,
	};
}

/** A tool-call block must never be offered, so build an assistant message that has one. */
function assistantWithToolCall(id: string, args: string): ShakeCandidateEntry {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc", name: "bash", arguments: { command: args } }],
			timestamp: 0,
		} as never,
	};
}

const FENCE = "```";

function fenced(tokens: number): string {
	return `${FENCE}\n${textOfTokens(tokens)}\n${FENCE}`;
}

/** Padding entries so earlier entries fall outside the protect window. */
function tail(tokensEach: number, count: number): ShakeCandidateEntry[] {
	return Array.from({ length: count }, (_, i) => userEntry(`tail-${i}`, textOfTokens(tokensEach)));
}

const TEST_CONFIG: ShakeConfig = {
	protectTokens: 1_000,
	minSavings: 0,
	protectedTools: [],
	fenceMinTokens: 100,
};

describe("collectShakeRegions", () => {
	it("returns nothing for an empty branch", () => {
		expect(collectShakeRegions([], TEST_CONFIG, NO_SHAKEN, estimateTokens)).toEqual([]);
	});

	it("skips entries inside the protect-recent window", () => {
		// Only 500 tokens follow the tool result, below protectTokens of 1000.
		const entries = [toolResultEntry("t1", "bash", textOfTokens(5_000)), ...tail(500, 1)];
		expect(collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens)).toEqual([]);
	});

	it("offers a tool result once enough context follows it", () => {
		const entries = [toolResultEntry("t1", "bash", textOfTokens(5_000)), ...tail(600, 2)];
		const regions = collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({ kind: "toolResult", entryId: "t1", label: "bash" });
	});

	it("skips entries before the compaction boundary", () => {
		const entries = [
			toolResultEntry("old", "bash", textOfTokens(5_000)),
			toolResultEntry("kept", "bash", textOfTokens(5_000)),
			...tail(600, 2),
		];
		const regions = collectShakeRegions(
			entries,
			{ ...TEST_CONFIG, keepBoundaryId: "kept" },
			NO_SHAKEN,
			estimateTokens,
		);
		expect(regions.map((region) => region.entryId)).toEqual(["kept"]);
	});

	it("skips protected tools", () => {
		const entries = [toolResultEntry("t1", "todo_write", textOfTokens(5_000)), ...tail(600, 2)];
		const regions = collectShakeRegions(
			entries,
			{ ...TEST_CONFIG, protectedTools: ["todo_write"] },
			NO_SHAKEN,
			estimateTokens,
		);
		expect(regions).toEqual([]);
	});

	it("honors a predicate matcher", () => {
		const entries = [toolResultEntry("t1", "bash", textOfTokens(5_000)), ...tail(600, 2)];
		const regions = collectShakeRegions(
			entries,
			{ ...TEST_CONFIG, protectedTools: [(message) => message.toolCallId === "call-t1"] },
			NO_SHAKEN,
			estimateTokens,
		);
		expect(regions).toEqual([]);
	});

	it("skips tool results already shaken", () => {
		const entries = [toolResultEntry("t1", "bash", textOfTokens(5_000)), ...tail(600, 2)];
		const shaken: ShakenIndex = new Map([["t1", new Set([WHOLE_TOOL_RESULT])]]);
		expect(collectShakeRegions(entries, TEST_CONFIG, shaken, estimateTokens)).toEqual([]);
	});

	it("returns [] when total savings fall below minSavings", () => {
		const entries = [toolResultEntry("t1", "bash", textOfTokens(200)), ...tail(600, 2)];
		const regions = collectShakeRegions(entries, { ...TEST_CONFIG, minSavings: 4_000 }, NO_SHAKEN, estimateTokens);
		expect(regions).toEqual([]);
	});

	it("never offers a tool-call block", () => {
		const entries = [assistantWithToolCall("a1", textOfTokens(5_000)), ...tail(600, 2)];
		expect(collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens)).toEqual([]);
	});

	describe("fenced and XML block detection", () => {
		it("offers a large fenced block in an assistant message", () => {
			const entries = [assistantEntry("a1", `before\n${fenced(2_000)}\nafter`), ...tail(600, 2)];
			const regions = collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens);
			expect(regions).toHaveLength(1);
			expect(regions[0]).toMatchObject({ kind: "block", entryId: "a1", blockIndex: 0, label: "assistant" });
		});

		it("ignores a fenced block below fenceMinTokens", () => {
			const entries = [assistantEntry("a1", fenced(10)), ...tail(600, 2)];
			expect(collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens)).toEqual([]);
		});

		it("ignores an unterminated fence", () => {
			const entries = [assistantEntry("a1", `${FENCE}\n${textOfTokens(2_000)}`), ...tail(600, 2)];
			expect(collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens)).toEqual([]);
		});

		it("offers a top-level XML block", () => {
			const entries = [assistantEntry("a1", `<data>\n${textOfTokens(2_000)}\n</data>`), ...tail(600, 2)];
			const regions = collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens);
			expect(regions).toHaveLength(1);
			expect(regions[0].kind).toBe("block");
		});

		it("does not treat XML inside a fence as its own block", () => {
			const inner = `<data>\n${textOfTokens(2_000)}\n</data>`;
			const entries = [assistantEntry("a1", `${FENCE}\n${inner}\n${FENCE}`), ...tail(600, 2)];
			const regions = collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens);
			// One region for the fence, not an extra one for the nested XML.
			expect(regions).toHaveLength(1);
		});

		it("keeps only the outermost span when XML nests", () => {
			const entries = [
				assistantEntry("a1", `<outer>\n<inner>\n${textOfTokens(2_000)}\n</inner>\n</outer>`),
				...tail(600, 2),
			];
			const regions = collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens);
			expect(regions).toHaveLength(1);
			expect(regions[0]).toMatchObject({ start: 0 });
		});

		it("scans custom_message content", () => {
			const entries: ShakeCandidateEntry[] = [
				{ type: "custom_message", id: "c1", content: fenced(2_000) },
				...tail(600, 2),
			];
			const regions = collectShakeRegions(entries, TEST_CONFIG, NO_SHAKEN, estimateTokens);
			expect(regions).toHaveLength(1);
			expect(regions[0]).toMatchObject({ kind: "block", entryId: "c1", blockIndex: -1, label: "custom" });
		});
	});

	describe("prompt-cache guard", () => {
		// protectTokens fences off the newest end, cacheWarmSuffixTokens the oldest end. Only the
		// middle band is eligible; getting the direction wrong turns shake into a silent no-op.
		const banded: ShakeConfig = { ...TEST_CONFIG, protectTokens: 1_000, cacheWarmSuffixTokens: 5_000 };

		it("offers an entry inside the band", () => {
			// 2000 tokens follow t1: above protectTokens, below cacheWarmSuffixTokens.
			const entries = [toolResultEntry("t1", "bash", textOfTokens(3_000)), ...tail(1_000, 2)];
			const regions = collectShakeRegions(entries, banded, NO_SHAKEN, estimateTokens);
			expect(regions.map((region) => region.entryId)).toEqual(["t1"]);
		});

		it("skips an entry too deep to be worth invalidating", () => {
			// 8000 tokens follow t1, past cacheWarmSuffixTokens: it is in the warm cached prefix.
			const entries = [toolResultEntry("t1", "bash", textOfTokens(3_000)), ...tail(1_000, 8)];
			expect(collectShakeRegions(entries, banded, NO_SHAKEN, estimateTokens)).toEqual([]);
		});

		it("skips an entry too recent even when the guard is armed", () => {
			const entries = [toolResultEntry("t1", "bash", textOfTokens(3_000)), ...tail(500, 1)];
			expect(collectShakeRegions(entries, banded, NO_SHAKEN, estimateTokens)).toEqual([]);
		});
	});
});

describe("resolveShakeConfig", () => {
	it("passes through a config whose band is non-empty", () => {
		const config: ShakeConfig = { ...TEST_CONFIG, protectTokens: 1_000, cacheWarmSuffixTokens: 5_000 };
		expect(resolveShakeConfig(config).cacheWarmSuffixTokens).toBe(5_000);
	});

	it("disarms the guard and warns when the band would be empty", () => {
		const warnings: string[] = [];
		const config: ShakeConfig = { ...TEST_CONFIG, protectTokens: 5_000, cacheWarmSuffixTokens: 1_000 };
		const resolved = resolveShakeConfig(config, (warning) => warnings.push(warning));
		expect(resolved.cacheWarmSuffixTokens).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("cacheWarmSuffixTokens");
	});

	it("leaves an unarmed guard alone", () => {
		const warnings: string[] = [];
		const resolved = resolveShakeConfig(TEST_CONFIG, (warning) => warnings.push(warning));
		expect(resolved.cacheWarmSuffixTokens).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("keeps every shipped preset's band usable", () => {
		for (const preset of [DEFAULT_SHAKE_CONFIG, AGGRESSIVE_SHAKE_CONFIG, RESCUE_SHAKE_CONFIG]) {
			const warnings: string[] = [];
			resolveShakeConfig(preset, (warning) => warnings.push(warning));
			expect(warnings).toEqual([]);
		}
	});
});
