import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

export interface WebSearchResultItem {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchOperations {
	search(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResultItem[]>;
}

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseTavilyResults(payload: unknown): WebSearchResultItem[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new Error("Tavily returned an invalid search response: missing results array.");
	}

	return payload.results.map((item, index) => {
		if (!isRecord(item)) {
			throw new Error(`Tavily returned an invalid result at index ${index}.`);
		}
		const { title, url, content } = item;
		if (typeof title !== "string" || typeof url !== "string" || typeof content !== "string") {
			throw new Error(`Tavily returned an invalid result at index ${index}.`);
		}
		return { title, url, snippet: content };
	});
}

/** Tavily Search API backend. Uses basic search (one credit) and returns result snippets only. */
export function createTavilyWebSearchOperations(apiKey: string, fetchImpl: typeof fetch = fetch): WebSearchOperations {
	const normalizedApiKey = apiKey.trim();
	if (!normalizedApiKey) {
		throw new Error("TAVILY_API_KEY must not be empty.");
	}

	return {
		async search(query, limit, signal) {
			const maxResults = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit)));
			const response = await fetchImpl(TAVILY_SEARCH_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${normalizedApiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query,
					search_depth: "basic",
					include_answer: false,
					include_raw_content: false,
					max_results: maxResults,
				}),
				signal,
			});

			if (!response.ok) {
				const detail = (await response.text()).slice(0, 500).trim().replaceAll(normalizedApiKey, "[redacted]");
				throw new Error(`Tavily search failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
			}

			return parseTavilyResults(await response.json());
		},
	};
}

/** Returns the configured built-in search backend, or undefined when web search is not configured. */
export function createDefaultWebSearchOperations(
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl: typeof fetch = fetch,
): WebSearchOperations | undefined {
	const apiKey = env.TAVILY_API_KEY?.trim();
	return apiKey ? createTavilyWebSearchOperations(apiKey, fetchImpl) : undefined;
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query." }),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Max results to return. Default 5." }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export function createWebSearchToolDefinition(
	ops: WebSearchOperations,
): ToolDefinition<typeof webSearchSchema, { count: number }> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web and return titles, URLs, and snippets for the top results.",
		promptSnippet: "Search the web",
		parameters: webSearchSchema,
		async execute(_toolCallId, input: WebSearchToolInput, signal) {
			const results = await ops.search(input.query, input.limit ?? DEFAULT_SEARCH_LIMIT, signal);
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No results." }], details: { count: 0 } };
			}
			const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
			return { content: [{ type: "text", text }], details: { count: results.length } };
		},
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? args.query : "";
			return new Text(theme.fg("toolTitle", theme.bold(`web_search "${query}"`)), 0, 0);
		},
	};
}
