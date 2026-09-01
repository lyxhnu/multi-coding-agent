import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { McpManager } from "../mcp/mcp-manager.ts";

const useToolSchema = Type.Object({
	server_id: Type.String({ description: "The MCP server id (as returned by search_tool)." }),
	tool_name: Type.String({ description: "The MCP tool name (as returned by search_tool)." }),
	arguments: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arguments matching the tool's input schema." }),
	),
});

export interface McpUseToolInput {
	server_id: string;
	tool_name: string;
	arguments?: Record<string, unknown>;
}

/** use_tool (spec 13, stage 2): invokes an MCP tool discovered via search_tool. */
export function createMcpUseToolDefinition(
	manager: McpManager,
): ToolDefinition<typeof useToolSchema, { serverId: string; toolName: string }> {
	return {
		name: "use_tool",
		label: "use_tool",
		description: "Call an MCP tool previously found via search_tool.",
		promptSnippet: "Call a discovered MCP tool",
		parameters: useToolSchema,
		async execute(_toolCallId, input: McpUseToolInput) {
			const result = await manager.useTool(input.server_id, input.tool_name, input.arguments ?? {});
			return {
				content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
				details: { serverId: input.server_id, toolName: input.tool_name },
			};
		},
		renderCall(args, theme) {
			const toolName = typeof args?.tool_name === "string" ? args.tool_name : "";
			return new Text(theme.fg("toolTitle", theme.bold(`use_tool ${toolName}`)), 0, 0);
		},
	};
}
