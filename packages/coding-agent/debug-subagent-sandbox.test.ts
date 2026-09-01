import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./test/suite/harness.ts";

describe("debug", () => {
	it("debug subagent write", async () => {
		const harness = await createHarness();
		const markerPath = join(harness.tempDir, "should-exist.txt");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { description: "write a file", prompt: `run: touch ${markerPath}`, subagent_type: "general-purpose", run_in_background: false }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${markerPath}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote the file"),
			fauxAssistantMessage("subagent reported success"),
		]);
		await harness.session.prompt("delegate a write to a general-purpose subagent");
		const allMessages = harness.session.messages.map((m) => ({ role: m.role, text: getMessageText(m), isError: (m as any).isError }));
		writeFileSync("/tmp/debug-messages.json", JSON.stringify(allMessages, null, 2));
		harness.cleanup();
	});
});
