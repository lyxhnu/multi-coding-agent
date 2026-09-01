import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const FAKE_MCP_SERVER_PATH = fileURLToPath(new URL("./fixtures/fake-mcp-server.cjs", import.meta.url));
const fakeMcpServers = [{ id: "fake", command: process.execPath, args: [FAKE_MCP_SERVER_PATH] }];

describe("web_fetch / web_search (M8)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("registers web_fetch but omits web_search when no provider is configured", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((t) => t.name);
		expect(allToolNames).toContain("web_fetch");
		expect(allToolNames).not.toContain("web_search");
		expect(harness.session.getActiveToolNames()).not.toContain("web_fetch");
		expect(harness.session.getActiveToolNames()).not.toContain("web_search");
	});

	it("web_fetch returns the fetched (and HTML-stripped) content via a fake operations backend", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["web_fetch"],
			settings: { permissions: { allow: [{ pattern: "web_fetch:*" }] } },
			webFetchOperations: {
				fetch: async (url) => ({
					status: 200,
					contentType: "text/html",
					body: `<html><body><h1>Hello ${url}</h1></body></html>`,
				}),
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("fetch https://example.com");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(getMessageText(toolResult)).toContain("Hello https://example.com");
		expect(getMessageText(toolResult)).not.toContain("<h1>");
	});

	it("web_search returns formatted results via a fake operations backend", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["web_search"],
			settings: { permissions: { allow: [{ pattern: "web_search:*" }] } },
			webSearchOperations: {
				search: async (query) => [
					{ title: `Result for ${query}`, url: "https://example.com/1", snippet: "a snippet" },
				],
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "pi coding agent" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for pi coding agent");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(getMessageText(toolResult)).toContain("Result for pi coding agent");
		expect(getMessageText(toolResult)).toContain("https://example.com/1");
	});
});

describe("search_tool / use_tool (MCP, M8)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("are NOT registered when no MCP server is configured", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((t) => t.name);
		expect(allToolNames).not.toContain("search_tool");
		expect(allToolNames).not.toContain("use_tool");
	});

	it("are registered but not implicitly activated once an MCP server is configured", async () => {
		const harness = await createHarness({ mcpServers: fakeMcpServers });
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((t) => t.name);
		expect(allToolNames).toContain("search_tool");
		expect(allToolNames).toContain("use_tool");
		expect(harness.session.getActiveToolNames()).not.toContain("search_tool");
		expect(harness.session.getActiveToolNames()).not.toContain("use_tool");
	});

	it("search_tool finds a matching tool (with its schema) without dumping every tool up front", async () => {
		const harness = await createHarness({
			mcpServers: fakeMcpServers,
			initialActiveToolNames: ["use_tool"],
			settings: { permissions: { allow: [{ pattern: "use_tool:*" }] } },
		});
		harnesses.push(harness);
		const matches = await harness.session.mcpManager.searchTools("weather");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.name).toBe("get_weather");
		expect(matches[0]?.serverId).toBe("fake");
		expect(matches[0]?.inputSchema).toBeTruthy();
	});

	it("use_tool calls the real MCP server end-to-end through the agent loop", async () => {
		const harness = await createHarness({
			mcpServers: fakeMcpServers,
			initialActiveToolNames: ["use_tool"],
			settings: { permissions: { allow: [{ pattern: "use_tool:*" }] } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("use_tool", { server_id: "fake", tool_name: "get_weather", arguments: { city: "Berlin" } }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("what is the weather in Berlin?");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(getMessageText(toolResult)).toContain("sunny in Berlin");
	});
});
