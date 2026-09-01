import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { SessionTraceEntry } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

describe("AgentSession trace", () => {
	it("records request, stream, tool, and boundary events without changing the session branch", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: typeof params === "object" && params !== null && "text" in params ? String(params.text) : "",
					},
				],
				details: {},
			}),
		};
		const harness = await createHarness({ tools: [echoTool] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("start");

			const traceEntries = harness.sessionManager
				.getEntries()
				.filter((entry): entry is SessionTraceEntry => entry.type === "trace");
			const traceTypes = traceEntries.map((entry) => entry.event.type);
			expect(traceTypes.filter((type) => type === "turn/start")).toHaveLength(1);
			expect(traceTypes.filter((type) => type === "step/start")).toHaveLength(2);
			expect(traceTypes.filter((type) => type === "request/header")).toHaveLength(2);
			expect(traceTypes).toContain("assistant/chunk");
			expect(traceTypes.filter((type) => type === "tool/call")).toHaveLength(1);
			expect(traceTypes.filter((type) => type === "tool/result")).toHaveLength(1);
			expect(traceTypes.filter((type) => type === "step/end")).toHaveLength(2);
			expect(traceTypes.filter((type) => type === "turn/end")).toHaveLength(1);

			const requests = traceEntries.flatMap((entry) => (entry.event.type === "request/header" ? [entry.event] : []));
			expect(requests[0]?.data.header).toEqual(
				expect.objectContaining({
					provider: harness.getModel().provider,
					model: harness.getModel().id,
					systemPrompt: harness.session.systemPrompt,
				}),
			);
			expect(requests[0]?.data.header.messages.map((message) => message.role)).toEqual(["user"]);
			expect(requests[1]?.data.header.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
			]);
			const toolCall = traceEntries.find((entry) => entry.event.type === "tool/call");
			expect(toolCall?.event).toEqual(
				expect.objectContaining({
					type: "tool/call",
					data: expect.objectContaining({ name: "echo", arguments: { text: "hello" } }),
				}),
			);

			expect(harness.sessionManager.getBranch().every((entry) => entry.type !== "trace")).toBe(true);
			expect(
				harness.sessionManager
					.getTree()
					.flatMap((node) => node.entry)
					.every((entry) => entry.type !== "trace"),
			).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});
});
