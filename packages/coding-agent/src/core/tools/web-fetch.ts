import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

export interface WebFetchResult {
	status: number;
	contentType?: string;
	body: string;
	truncated?: boolean;
}

export interface WebFetchOperations {
	fetch(url: string, signal?: AbortSignal): Promise<WebFetchResult>;
}

const MAX_FETCH_BYTES = 64 * 1024;

/** Real, network-backed implementation using Node's built-in fetch(). No API key required. */
export function createDefaultWebFetchOperations(): WebFetchOperations {
	return {
		async fetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
			const response = await fetch(url, { redirect: "follow", signal });
			const reader = response.body?.getReader();
			const chunks: Uint8Array[] = [];
			let received = 0;
			let truncated = false;
			if (reader) {
				while (received < MAX_FETCH_BYTES) {
					const next = await reader.read();
					if (next.done) break;
					const remaining = MAX_FETCH_BYTES - received;
					chunks.push(next.value.subarray(0, remaining));
					received += Math.min(next.value.length, remaining);
					if (next.value.length > remaining) {
						truncated = true;
						break;
					}
				}
				if (received >= MAX_FETCH_BYTES) truncated = true;
				if (truncated) await reader.cancel();
			}
			const body = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
			return {
				status: response.status,
				contentType: response.headers.get("content-type") ?? undefined,
				body,
				truncated,
			};
		},
	};
}

function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const MAX_FETCH_CHARS = 20_000;

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch." }),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export function createWebFetchToolDefinition(
	ops: WebFetchOperations,
): ToolDefinition<typeof webFetchSchema, { url: string; status: number }> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: "Fetch a URL and return its content as readable text (HTML is stripped down to text).",
		promptSnippet: "Fetch a URL's content",
		parameters: webFetchSchema,
		async execute(_toolCallId, input: WebFetchToolInput, signal) {
			const result = await ops.fetch(input.url, signal);
			if (result.status >= 400) {
				throw new Error(`web_fetch received HTTP ${result.status} for ${input.url}`);
			}
			const isHtml = (result.contentType ?? "").includes("html");
			let text = isHtml ? htmlToText(result.body) : result.body;
			let truncated = result.truncated ?? false;
			if (text.length > MAX_FETCH_CHARS) {
				text = text.slice(0, MAX_FETCH_CHARS);
				truncated = true;
			}
			const header = `[${result.status}] ${input.url}${truncated ? " (truncated)" : ""}`;
			return {
				content: [{ type: "text", text: `${header}\n\n${text}` }],
				details: { url: input.url, status: result.status },
			};
		},
		renderCall(args, theme) {
			const url = typeof args?.url === "string" ? args.url : "";
			return new Text(theme.fg("toolTitle", theme.bold(`web_fetch ${url}`)), 0, 0);
		},
	};
}
