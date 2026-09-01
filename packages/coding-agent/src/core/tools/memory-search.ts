import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryStore } from "../memory/memory-store.ts";

const memorySearchSchema = Type.Object({
	query: Type.String({
		description: "What to look for in curated memory (global + project MEMORY.md and session notes).",
	}),
	scope: Type.Optional(
		Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("all")], {
			description: "Which memory to search. Default: project.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max results to return. Default 10." })),
});

export type MemorySearchToolInput = Static<typeof memorySearchSchema>;

export function createMemorySearchToolDefinition(
	store: MemoryStore,
	cwd: string,
): ToolDefinition<typeof memorySearchSchema, { count: number }> {
	return {
		name: "memory_search",
		label: "memory_search",
		description:
			"Search curated long-term memory (global and/or project MEMORY.md plus session notes) for facts, " +
			"decisions, or conventions recorded in earlier sessions.",
		promptSnippet: "Search curated long-term memory",
		parameters: memorySearchSchema,
		async execute(_toolCallId, input: MemorySearchToolInput) {
			const hits = await store.search(input.query, input.scope ?? "project", cwd, input.limit);
			if (hits.length === 0) {
				return { content: [{ type: "text", text: "No memory entries matched." }], details: { count: 0 } };
			}
			const text = hits
				.map((hit, i) => `${i + 1}. [${hit.path}] ${hit.heading} (score ${hit.score})\n   ${hit.snippet}`)
				.join("\n");
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? args.query : "";
			return new Text(theme.fg("toolTitle", theme.bold(`memory_search "${query}"`)), 0, 0);
		},
	};
}
