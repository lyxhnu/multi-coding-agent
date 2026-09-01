import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MemoryStore } from "../memory/memory-store.ts";

const memoryGetSchema = Type.Object({
	path: Type.String({
		description: 'Path returned by memory_search (or "MEMORY.md" for the global file), relative to the memory root.',
	}),
});

export type MemoryGetToolInput = Static<typeof memoryGetSchema>;

export function createMemoryGetToolDefinition(
	store: MemoryStore,
): ToolDefinition<typeof memoryGetSchema, { path: string }> {
	return {
		name: "memory_get",
		label: "memory_get",
		description:
			"Read the full content of a memory file by path (as returned by memory_search). Cannot escape the memory root.",
		promptSnippet: "Read a memory file by path",
		parameters: memoryGetSchema,
		async execute(_toolCallId, input: MemoryGetToolInput) {
			const content = store.get(input.path);
			if (content === undefined) {
				throw new Error(`Could not read memory file "${input.path}" (not found, or outside the memory root).`);
			}
			return { content: [{ type: "text", text: content }], details: { path: input.path } };
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "";
			return new Text(theme.fg("toolTitle", theme.bold(`memory_get ${path}`)), 0, 0);
		},
	};
}
