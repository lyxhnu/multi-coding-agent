import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./truncate.ts";

export interface ToolResultProjectionOptions {
	maxBytes?: number;
	maxLines?: number;
	sourceEntryId?: string;
}

function truncationMarker(sourceEntryId?: string): string {
	return sourceEntryId
		? `\n[Tool result truncated. Full saved text: history read_item entryId=${sourceEntryId}.]`
		: "\n[Tool result truncated to the inline output budget.]";
}

/** Enforce one aggregate text budget after tool-result hooks have finished mutating the result. */
export function boundToolResultContent(
	content: (TextContent | ImageContent)[] | null | undefined,
	options: ToolResultProjectionOptions = {},
): (TextContent | ImageContent)[] {
	const marker = truncationMarker(options.sourceEntryId);
	const markerBytes = Buffer.byteLength(marker, "utf-8");
	const output: (TextContent | ImageContent)[] = [];
	let remainingBytes = Math.max(0, (options.maxBytes ?? DEFAULT_MAX_BYTES) - markerBytes);
	let remainingLines = Math.max(0, (options.maxLines ?? DEFAULT_MAX_LINES) - 1);
	let truncated = false;

	for (const part of content ?? []) {
		if (part.type !== "text") {
			const bytes = Buffer.byteLength(part.data, "base64");
			if (bytes <= remainingBytes) {
				output.push(part);
				remainingBytes -= bytes;
			} else {
				truncated = true;
			}
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

	if (truncated) output.push({ type: "text", text: marker });
	return output;
}
