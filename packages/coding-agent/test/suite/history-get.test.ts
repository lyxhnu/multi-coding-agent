import { RESCUE_SHAKE_CONFIG } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHistoryGetToolDefinition, HISTORY_MAX_LIMIT } from "../../src/core/tools/history-get.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("memory-context-integrity: history_get", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses.splice(0)) await h.cleanup();
	});
	async function seed(toolName = "bash", blocks = ["中😀a".repeat(2000)]) {
		const h = await createHarness({ initialActiveToolNames: ["history_get"] });
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const id = h.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "original",
			toolName,
			isError: false,
			content: blocks.map((text) => ({ type: "text", text })),
			timestamp: 2,
		});
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		await h.session.shake(RESCUE_SHAKE_CONFIG, "manual");
		return { h, id, tool: createHistoryGetToolDefinition(h.sessionManager) };
	}
	it("H01/H02/K04 returns saved Unicode pages without rerunning the original tool", async () => {
		const { h, id, tool } = await seed();
		const result = await tool.execute(
			"get",
			{ entryId: id, offset: 1, limit: 3 },
			undefined,
			undefined,
			h.session.extensionRunner.createContext(),
		);
		expect(result.details).toMatchObject({ entryId: id, blockIndex: 0, offset: 1, end: 4, nextOffset: 4 });
		expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "").text).toBe("😀a中");
		expect(
			h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "trace" && entry.event.type === "request/header"),
		).toHaveLength(0);
	});
	it("H05/H06 survives compaction, branch export and restart", async () => {
		const { h, id } = await seed();
		const kept = h.sessionManager.appendMessage({ role: "user", content: "next", timestamp: 3 });
		h.sessionManager.appendCompaction("summary", kept, 10000);
		const saved = SessionManager.open(h.session.exportToJsonl(`${h.tempDir}/export.jsonl`));
		const result = await createHistoryGetToolDefinition(saved).execute(
			"get",
			{ entryId: id, limit: 3 },
			undefined,
			undefined,
			h.session.extensionRunner.createContext(),
		);
		expect(result.details).toMatchObject({ entryId: id, nextOffset: 3 });
	});
	it("H04 rejects sibling entries, paths and trace ids", async () => {
		const { h, id, tool } = await seed();
		const parent = h.sessionManager.getBranch()[0].id;
		h.sessionManager.branch(parent);
		for (const entryId of [id, "../../session.jsonl", "trace-id"])
			await expect(
				tool.execute("get", { entryId }, undefined, undefined, h.session.extensionRunner.createContext()),
			).rejects.toThrow();
	});
	it.each(["memory_get", "memory_search"])("H07 refuses stale %s results", async (name) => {
		const { h, id, tool } = await seed(name);
		await expect(
			tool.execute("get", { entryId: id }, undefined, undefined, h.session.extensionRunner.createContext()),
		).rejects.toThrow("current memory view");
	});
	it("H01/H02 requires explicit blocks and enforces page bounds", async () => {
		const { h, id, tool } = await seed("read", ["a".repeat(8000), "b".repeat(8000)]);
		await expect(
			tool.execute("get", { entryId: id }, undefined, undefined, h.session.extensionRunner.createContext()),
		).rejects.toThrow("blockIndex");
		for (const input of [{ limit: HISTORY_MAX_LIMIT + 1 }, { offset: -1 }, { blockIndex: 2 }])
			await expect(
				tool.execute(
					"get",
					{ entryId: id, ...input },
					undefined,
					undefined,
					h.session.extensionRunner.createContext(),
				),
			).rejects.toThrow();
		expect(
			(
				await tool.execute(
					"get",
					{ entryId: id, blockIndex: 1, offset: 8000 },
					undefined,
					undefined,
					h.session.extensionRunner.createContext(),
				)
			).details,
		).toMatchObject({
			nextOffset: null,
		});
	});
	it("H07 goes through active-tool and deny permissions in the agent loop", async () => {
		const { h, id } = await seed();
		h.settingsManager.applyOverrides({ permissions: { deny: [{ pattern: "history_get:*" }] } });
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("history_get", { entryId: id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("denied"),
		]);
		await h.session.prompt("read history");
		expect(h.eventsOfType("tool_execution_end")[0]?.isError).toBe(true);
	});
	it("H08 cannot reconstruct unsaved text or unsupported image content", async () => {
		const { h, id, tool } = await seed("read", ["SAVED ONLY".repeat(2000)]);
		const result = await tool.execute(
			"get",
			{ entryId: id, offset: 20000, limit: 1 },
			undefined,
			undefined,
			h.session.extensionRunner.createContext(),
		);
		expect(result.details).toMatchObject({ total: 20000, nextOffset: null, savedContentOnly: true });
		expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "").text).toBe("");
		const imageId = h.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "image",
			toolName: "read",
			isError: false,
			content: [{ type: "image", data: "dGVzdA==", mimeType: "image/png" }],
			timestamp: 4,
		});
		h.sessionManager.appendShake([{ kind: "toolResult", targetId: imageId, text: "removed image" }], 1000, "manual");
		await expect(
			tool.execute(
				"get",
				{ entryId: imageId, blockIndex: 0 },
				undefined,
				undefined,
				h.session.extensionRunner.createContext(),
			),
		).rejects.toThrow("not readable");
	});
	it.each(["inactive", "denied"])("H07/H08 does not advertise readback when history is %s", async (mode) => {
		const h = await createHarness({
			initialActiveToolNames: mode === "inactive" ? [] : ["history_get"],
			settings: mode === "denied" ? { permissions: { deny: [{ pattern: "history_get:*" }] } } : {},
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "large",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "large text".repeat(2000) }],
			timestamp: 1,
		});
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		await h.session.shake(RESCUE_SHAKE_CONFIG, "manual");
		expect(JSON.stringify(h.session.messages)).toContain("History readback is unavailable");
		expect(JSON.stringify(h.session.messages)).not.toContain("Use history_get");
	});
});
