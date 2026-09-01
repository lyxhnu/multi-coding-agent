import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/harness/compaction/compaction.ts";
import {
	applyRedactions,
	buildRedactions,
	buildShakenIndex,
	collectShakeRegions,
	type ShakeCandidateEntry,
	type ShakeConfig,
	type ShakenIndex,
	STRING_CONTENT,
	WHOLE_TOOL_RESULT,
} from "../src/harness/compaction/shake.ts";

const NO_SHAKEN: ShakenIndex = new Map();

const CONFIG: ShakeConfig = {
	protectTokens: 0,
	minSavings: 0,
	protectedTools: [],
	fenceMinTokens: 100,
};

function textOfTokens(tokens: number): string {
	return "x".repeat(tokens * 4);
}

const FENCE = "```";

function fenced(tokens: number): string {
	return `${FENCE}\n${textOfTokens(tokens)}\n${FENCE}`;
}

function toolResultEntry(id: string, text: string): ShakeCandidateEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: `call-${id}`,
		toolName: "bash",
		isError: false,
		timestamp: 0,
	} as ToolResultMessage;
	return { type: "message", id, message };
}

function assistantEntry(id: string, text: string): ShakeCandidateEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as never,
	};
}

function blockText(entry: ShakeCandidateEntry, index: number): string {
	const content = (entry.message as { content: Array<{ text?: string }> }).content;
	return content[index].text ?? "";
}

describe("buildRedactions", () => {
	it("emits a placeholder for a whole tool result", () => {
		const entries = [toolResultEntry("t1", textOfTokens(3_000))];
		const regions = collectShakeRegions(entries, CONFIG, NO_SHAKEN, estimateTokens);
		const redactions = buildRedactions(entries, regions);
		expect(redactions).toHaveLength(1);
		expect(redactions[0].kind).toBe("toolResult");
		expect(redactions[0].text).toContain("shaken:");
		expect(redactions[0].text).toContain("`bash`");
	});

	it("does not mutate the entries it reads", () => {
		const original = textOfTokens(3_000);
		const entries = [toolResultEntry("t1", original)];
		const regions = collectShakeRegions(entries, CONFIG, NO_SHAKEN, estimateTokens);
		buildRedactions(entries, regions);
		expect(blockText(entries[0], 0)).toBe(original);
	});

	it("stores the whole post-shake block text, keeping surrounding prose", () => {
		const entries = [assistantEntry("a1", `keep before\n${fenced(2_000)}\nkeep after`)];
		const regions = collectShakeRegions(entries, CONFIG, NO_SHAKEN, estimateTokens);
		const redactions = buildRedactions(entries, regions);
		expect(redactions).toHaveLength(1);
		expect(redactions[0].text).toContain("keep before");
		expect(redactions[0].text).toContain("keep after");
		expect(redactions[0].text).toContain("shaken:");
		expect(redactions[0].text).not.toContain(textOfTokens(2_000));
	});

	it("splices several regions in one block without corrupting offsets", () => {
		// Two fences in one text block: applying the first must not shift the second.
		const entries = [assistantEntry("a1", `${fenced(500)}\nmiddle marker\n${fenced(700)}`)];
		const regions = collectShakeRegions(entries, CONFIG, NO_SHAKEN, estimateTokens);
		expect(regions).toHaveLength(2);
		const redactions = buildRedactions(entries, regions);
		// One redaction per (entry, block), not per region.
		expect(redactions).toHaveLength(1);
		expect(redactions[0].text).toContain("middle marker");
		expect(redactions[0].text).not.toContain(textOfTokens(500));
		expect(redactions[0].text).not.toContain(textOfTokens(700));
		expect(redactions[0].text.match(/shaken:/g)).toHaveLength(2);
	});
});

describe("applyRedactions", () => {
	it("replaces a tool result's content with the placeholder", () => {
		const entries = [toolResultEntry("t1", textOfTokens(3_000))];
		const applied = applyRedactions(entries, [{ kind: "toolResult", targetId: "t1", text: "[gone]" }]);
		expect(blockText(applied[0], 0)).toBe("[gone]");
	});

	it("leaves the stored entry untouched", () => {
		const original = textOfTokens(3_000);
		const entries = [toolResultEntry("t1", original)];
		applyRedactions(entries, [{ kind: "toolResult", targetId: "t1", text: "[gone]" }]);
		expect(blockText(entries[0], 0)).toBe(original);
	});

	it("keeps the original reference for unaffected entries", () => {
		const entries = [toolResultEntry("t1", "a"), toolResultEntry("t2", "b")];
		const applied = applyRedactions(entries, [{ kind: "toolResult", targetId: "t1", text: "[gone]" }]);
		expect(applied[1]).toBe(entries[1]);
		expect(applied[0]).not.toBe(entries[0]);
	});

	it("is idempotent: applying the same redaction twice equals applying it once", () => {
		const entries = [toolResultEntry("t1", textOfTokens(3_000))];
		const once = applyRedactions(entries, [{ kind: "toolResult", targetId: "t1", text: "[gone]" }]);
		const twice = applyRedactions(entries, [
			{ kind: "toolResult", targetId: "t1", text: "[gone]" },
			{ kind: "toolResult", targetId: "t1", text: "[gone]" },
		]);
		expect(blockText(twice[0], 0)).toBe(blockText(once[0], 0));
	});

	it("lets a later redaction of the same target win", () => {
		const entries = [toolResultEntry("t1", textOfTokens(3_000))];
		const applied = applyRedactions(entries, [
			{ kind: "toolResult", targetId: "t1", text: "[first]" },
			{ kind: "toolResult", targetId: "t1", text: "[second]" },
		]);
		expect(blockText(applied[0], 0)).toBe("[second]");
	});

	it("ignores a redaction whose target is gone (dropped by compaction)", () => {
		const entries = [toolResultEntry("t1", "kept")];
		const applied = applyRedactions(entries, [{ kind: "toolResult", targetId: "missing", text: "[gone]" }]);
		expect(applied).toHaveLength(1);
		expect(blockText(applied[0], 0)).toBe("kept");
	});

	it("replaces one block of an array-form message", () => {
		const entries = [assistantEntry("a1", "original")];
		const applied = applyRedactions(entries, [{ kind: "block", targetId: "a1", blockIndex: 0, text: "replaced" }]);
		expect(blockText(applied[0], 0)).toBe("replaced");
	});

	it("replaces string-form custom_message content", () => {
		const entries: ShakeCandidateEntry[] = [{ type: "custom_message", id: "c1", content: "original" }];
		const applied = applyRedactions(entries, [
			{ kind: "block", targetId: "c1", blockIndex: STRING_CONTENT, text: "replaced" },
		]);
		expect(applied[0].content).toBe("replaced");
	});

	it("survives a full round trip: detect, build, apply", () => {
		const entries = [assistantEntry("a1", `intro\n${fenced(2_000)}`), toolResultEntry("t1", textOfTokens(3_000))];
		const regions = collectShakeRegions(entries, CONFIG, NO_SHAKEN, estimateTokens);
		const applied = applyRedactions(entries, buildRedactions(entries, regions));
		expect(blockText(applied[0], 0)).toContain("intro");
		expect(blockText(applied[0], 0)).toContain("shaken:");
		expect(blockText(applied[1], 0)).toContain("shaken:");
	});
});

describe("buildShakenIndex", () => {
	it("marks a whole tool result", () => {
		const index = buildShakenIndex([{ kind: "toolResult", targetId: "t1", text: "x" }]);
		expect(index.get("t1")?.has(WHOLE_TOOL_RESULT)).toBe(true);
	});

	it("marks individual block indices and merges per target", () => {
		const index = buildShakenIndex([
			{ kind: "block", targetId: "a1", blockIndex: 0, text: "x" },
			{ kind: "block", targetId: "a1", blockIndex: 2, text: "y" },
		]);
		expect([...(index.get("a1") ?? [])].sort()).toEqual([0, 2]);
	});

	it("feeds back into detection so a second pass skips what the first shook", () => {
		const entries = [toolResultEntry("t1", textOfTokens(3_000))];
		const firstPass = collectShakeRegions(entries, CONFIG, NO_SHAKEN, estimateTokens);
		const shaken = buildShakenIndex(buildRedactions(entries, firstPass));
		expect(collectShakeRegions(entries, CONFIG, shaken, estimateTokens)).toEqual([]);
	});
});
