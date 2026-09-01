import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("memory_search / memory_get (M5)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("is omitted when memory is disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).not.toContain("memory_search");
		expect(allToolNames).not.toContain("memory_get");
	});

	it("registers memory tools when enabled without activating them implicitly", async () => {
		const harness = await createHarness({ settings: { memory: { enabled: true } } });
		harnesses.push(harness);
		const allToolNames = harness.session.getAllTools().map((tool) => tool.name);
		expect(allToolNames).toContain("memory_search");
		expect(allToolNames).toContain("memory_get");
		expect(harness.session.getActiveToolNames()).not.toContain("memory_search");
		expect(harness.session.getActiveToolNames()).not.toContain("memory_get");
	});

	it("stores writes under a workspace-hashed project directory, never the real home directory", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			initialActiveToolNames: ["memory_search", "memory_get"],
		});
		harnesses.push(harness);
		expect(harness.session.memoryStore.rootDir).toContain(harness.tempDir);
		expect(harness.session.memoryStore.rootDir).not.toContain("/.pi/agent/memory");
	});

	it("finds a project memory entry via memory_search and reads it back via memory_get", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			initialActiveToolNames: ["memory_search", "memory_get"],
		});
		harnesses.push(harness);
		harness.session.memoryStore.appendProject(harness.tempDir, ["The build command is `npm run build`."]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_search", { query: "build command" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("found it"),
		]);
		await harness.session.prompt("how do I build this repo?");
		const searchResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		const searchText = getMessageText(searchResult);
		expect(searchText).toContain("npm run build");
		const pathMatch = searchText.match(/\[([^\]]+MEMORY\.md)\]/);
		expect(pathMatch).not.toBeNull();

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_get", { path: pathMatch![1]! }), { stopReason: "toolUse" }),
			fauxAssistantMessage("read it"),
		]);
		await harness.session.prompt("read that file");
		const getResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(getMessageText(getResult)).toContain("npm run build");
	});

	it("discards (does not write) a candidate that looks like a secret", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const result = harness.session.memoryStore.appendProject(harness.tempDir, [
			"API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
		]);
		expect(result.written).toBe(0);
		expect(result.skipped).toBe(1);
		const hits = await harness.session.memoryStore.search("API_KEY", "project", harness.tempDir, 10);
		expect(hits).toHaveLength(0);
	});

	it("memory_get refuses to read outside the memory root (path traversal)", async () => {
		const harness = await createHarness({
			settings: { memory: { enabled: true } },
			initialActiveToolNames: ["memory_get"],
		});
		harnesses.push(harness);
		harness.session.memoryStore.appendProject(harness.tempDir, ["safe note"]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory_get", { path: "../../../../etc/passwd" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read /etc/passwd via memory_get");
		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
	});

	it("undo() tombstones a global memory entry so it no longer surfaces in search", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const result = harness.session.memoryStore.appendGlobal(["Always run tests before committing."]);
		expect(result.written).toBe(1);
		expect(await harness.session.memoryStore.search("committing", "global", harness.tempDir, 10)).toHaveLength(1);

		const undone = harness.session.memoryStore.undo("global", undefined, result.ids[0]!);
		expect(undone).toBe(true);
		expect(await harness.session.memoryStore.search("committing", "global", harness.tempDir, 10)).toHaveLength(0);
	});
});
