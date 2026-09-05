import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("memory-context-integrity: request preflight", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses.splice(0)) await h.cleanup();
	});

	it("B03/E06 rejects first oversized request without assistant or provider call, preserving export trace", async () => {
		const h = await createHarness({ persistSession: true, tools: [], settings: { compaction: { enabled: false } } });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("must not consume")]);
		await h.session.prompt("x".repeat(h.getModel().contextWindow * 4));
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(h.session.state.runState).toMatchObject({ status: "idle", lastOutcome: { type: "context_limit" } });
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "trace" && entry.event.type === "request/header"),
		).toHaveLength(0);
		const reopened = SessionManager.open(h.session.sessionFile!);
		expect(reopened.getBranch().map((entry) => entry.type)).toEqual(["custom", "message"]);
		expect(reopened.getBranch()[0]).toMatchObject({ type: "custom", customType: "context-prompt-generation" });
		expect(
			reopened.getBranchWithTrace().some((entry) => entry.type === "trace" && entry.event.type === "context/budget"),
		).toBe(true);
		const forked = reopened.createBranchedSession(reopened.getLeafId()!)!;
		expect(
			SessionManager.open(forked)
				.getBranchWithTrace()
				.some((entry) => entry.type === "trace" && entry.event.type === "context/budget"),
		).toBe(true);
		const file = h.session.exportToJsonl(`${h.tempDir}/limited.jsonl`);
		const restored = SessionManager.open(file);
		expect(
			restored.getBranchWithTrace().some((entry) => entry.type === "trace" && entry.event.type === "context/budget"),
		).toBe(true);
	});

	it("B01/B11 tool result is counted before next request and executed only once", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "large",
			label: "large",
			description: "large",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "result data line\n".repeat(10000) }], details: {} };
			},
		};
		const h = await createHarness({
			models: [{ id: "small", contextWindow: 12000, maxTokens: 1000 }],
			tools: [tool],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("not sent"),
		]);
		await h.session.prompt("run");
		expect(executions).toBe(1);
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "trace" && entry.event.type === "request/header"),
		).toHaveLength(1);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.state.runState).toMatchObject({ status: "idle", lastOutcome: { type: "context_limit" } });
	});

	it("B05 applies the guard after extension transform", async () => {
		const h = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("context", () => ({ messages: [{ role: "user", content: "x".repeat(1_000_000), timestamp: 1 }] }));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("not sent")]);
		await h.session.prompt("small input");
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "trace" && entry.event.type === "request/header"),
		).toHaveLength(0);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
	});

	it("B09 completed answers do not trigger an extra main request", async () => {
		const h = await createHarness({ tools: [] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("finish");
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "trace" && entry.event.type === "request/header"),
		).toHaveLength(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
	});
});
