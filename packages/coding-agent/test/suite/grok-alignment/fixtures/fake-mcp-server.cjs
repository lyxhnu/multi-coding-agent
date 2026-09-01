#!/usr/bin/env node
/**
 * Minimal fake MCP server for tests (see mcp-tools.test.ts): speaks newline-delimited JSON-RPC with just
 * enough of the MCP surface (initialize, tools/list, tools/call) to exercise McpManager without a real
 * MCP server dependency.
 */

const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

const TOOLS = [
	{ name: "get_weather", description: "Get the current weather for a city", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
	{ name: "unrelated_tool", description: "Does something else entirely", inputSchema: { type: "object" } },
];

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-mcp", version: "1" } } });
		return;
	}
	if (message.method === "notifications/initialized") {
		return; // notification: no response
	}
	if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
		return;
	}
	if (message.method === "tools/call") {
		const { name, arguments: args } = message.params;
		if (name === "get_weather") {
			send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `sunny in ${args?.city ?? "?"}` }] } });
			return;
		}
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
		return;
	}
	if (message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
});

process.on("SIGTERM", () => process.exit(0));
