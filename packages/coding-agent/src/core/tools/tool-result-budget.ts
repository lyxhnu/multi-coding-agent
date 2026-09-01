import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.ts";

const TRUNCATION_MARKER = "\n[Tool result truncated to the inline output budget.]";
const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");

/** Enforce one aggregate text budget after tool-result hooks have finished mutating the result. */
export function boundToolResultContent(
	content: (TextContent | ImageContent)[] | null | undefined,
): (TextContent | ImageContent)[] {
	const output: (TextContent | ImageContent)[] = [];
	let remainingBytes = Math.max(0, DEFAULT_MAX_BYTES - MARKER_BYTES);
	let remainingLines = Math.max(0, DEFAULT_MAX_LINES - 1);
	let truncated = false;

	for (const part of content ?? []) {
		if (part.type !== "text") {
			output.push(part);
			continue;
		}
		if (remainingBytes === 0 || remainingLines === 0) {
			truncated = true;
			continue;
		}
		const bounded = truncateHead(part.text, { maxBytes: remainingBytes, maxLines: remainingLines });
		if (bounded.content.length > 0) output.push({ ...part, text: bounded.content });
		remainingBytes -= bounded.outputBytes;
		remainingLines -= bounded.outputLines;
		truncated ||= bounded.truncated;
	}

	if (truncated) output.push({ type: "text", text: TRUNCATION_MARKER });
	return output;
}
