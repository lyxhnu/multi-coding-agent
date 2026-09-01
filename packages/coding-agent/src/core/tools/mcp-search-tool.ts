import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { McpManager } from "../mcp/mcp-manager.ts";

const searchToolSchema = Type.Object({
	query: Type.String({
		description: "What kind of MCP tool you're looking for (matched against tool names/descriptions).",
	}),
});

export type McpSearchToolInput = Static<typeof searchToolSchema>;

/**
 * search_tool (spec 13, stage 1 of MCP's two-stage discovery): searches every configured MCP server's
 * tools and returns full schemas only for the matches — never dumps every MCP tool's schema up front.
 */
export function createMcpSearchToolDefinition(
	manager: McpManager,
): ToolDefinition<typeof searchToolSchema, { count: number }> {
	return {
		name: "search_tool",
		label: "search_tool",
		description:
			"Search for available MCP tools by name/description across configured MCP servers. Returns full input schemas for matches; call use_tool to invoke one.",
		promptSnippet: "Search for an available MCP tool",
		parameters: searchToolSchema,
		async execute(_toolCallId, input: McpSearchToolInput) {
			const matches = await manager.searchTools(input.query);
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matching MCP tools found." }], details: { count: 0 } };
			}
			const text = matches
				.map(
					(m, i) =>
						`${i + 1}. server_id="${m.serverId}" tool_name="${m.name}"\n   ${m.description ?? "(no description)"}\n   input_schema: ${JSON.stringify(m.inputSchema ?? {})}`,
				)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { count: matches.length } };
		},
		renderCall(args, theme) {
			const query = typeof args?.query === "string" ? args.query : "";
			return new Text(theme.fg("toolTitle", theme.bold(`search_tool "${query}"`)), 0, 0);
		},
	};
}
