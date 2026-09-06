import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { History } from "../../src/core/history.ts";
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
		expect(reopened.getBranch().map((entry) => entry.type)).toEqual(["context_window", "custom", "message"]);
		expect(reopened.getBranch()[1]).toMatchObject({ type: "custom", customType: "context-prompt-generation" });
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

	it("B02 keeps the old window and fails explicitly when even the save-state request cannot fit", async () => {
		const h = await createHarness({ models: [{ id: "tiny", contextWindow: 6000, maxTokens: 1000 }] });
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("must not consume")]);
		await h.session.prompt("required input ".repeat(10000));
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "context_rollover")).toBe(false);
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "context_operation")).toEqual([
			expect.objectContaining({ state: "started", samplesUsed: 0 }),
		]);
		expect(h.session.state.runState).toMatchObject({
			lastOutcome: { type: "failed", message: "save_state_budget_exhausted" },
		});
	});

	it("B01/B11 persists a large result once and bounds the next provider request", async () => {
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
		).toHaveLength(2);
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.session.state.runState).toMatchObject({ status: "idle", lastOutcome: { type: "completed" } });
		const source = h.sessionManager.getBranch().find((entry) => entry.type === "tool_result_source");
		expect(source?.type === "tool_result_source" ? source.content[0] : undefined).toMatchObject({
			type: "text",
			text: "result data line\n".repeat(10000),
		});
		const projected = h.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(projected)).toContain("history read_item entryId=");
		if (source?.type !== "tool_result_source") throw new Error("missing authoritative result");
		const restored = new History(h.sessionManager).query({
			operation: "read_item",
			entryId: source.id,
			blockIndex: 0,
		});
		expect(restored.items[0]).toMatchObject({ entryId: source.id, offset: 0, total: 170000 });
		expect(JSON.stringify(restored)).toContain("result data line");
	});

	it("B04 bounds an amplified multi-result batch after extension hooks while retaining both sources", async () => {
		let executions = 0;
		const createLargeTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "original" }], details: { name } };
			},
		});
		const h = await createHarness({
			models: [{ id: "large-batch", contextWindow: 32000, maxTokens: 1000 }],
			tools: [createLargeTool("large_a"), createLargeTool("large_b")],
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => ({
						content: [{ type: "text", text: `${event.toolName}:`.repeat(30000) }],
						details: event.details,
					}));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("large_a", {}), fauxToolCall("large_b", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("run both");
		expect(executions).toBe(2);
		const sources = h.sessionManager.getBranch().filter((entry) => entry.type === "tool_result_source");
		expect(sources).toHaveLength(2);
		expect(sources.every((entry) => entry.content[0]?.type === "text" && entry.content[0].text.length > 100000)).toBe(
			true,
		);
		const projectedBytes = h.session.messages
			.filter((message) => message.role === "toolResult")
			.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message.content), "utf8"), 0);
		expect(projectedBytes).toBeLessThanOrEqual(53000);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
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
