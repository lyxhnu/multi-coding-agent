import { describe, expect, it } from "vitest";
import { boundToolResultContent } from "../src/core/tools/tool-result-budget.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

describe("tool result budget", () => {
	it("normalizes missing untyped tool content", () => {
		expect(boundToolResultContent(undefined)).toEqual([]);
		expect(boundToolResultContent(null)).toEqual([]);
	});

	it("bounds aggregate text while preserving image content", () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const result = boundToolResultContent([
			{ type: "text", text: "x".repeat(DEFAULT_MAX_BYTES * 2) },
			image,
			{ type: "text", text: "unreachable tail" },
		]);
		const text = result
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(text).toContain("Tool result truncated");
		expect(result).toContain(image);
	});
});
