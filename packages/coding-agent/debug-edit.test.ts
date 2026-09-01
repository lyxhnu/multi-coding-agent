import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "./test/suite/harness.ts";

describe("debug", () => {
  it("debug edit error", async () => {
    const harness = await createHarness({ settings: { permissions: { mode: "default" } } });
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("edit", { path: `${harness.tempDir}/f.txt`, edits: [{ oldText: "a", newText: "b" }] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await harness.session.prompt("edit the file");
    const result = harness.session.messages.filter((m) => m.role === "toolResult").pop();
    require("node:fs").writeFileSync("/tmp/debug-out.txt", getMessageText(result));
    harness.cleanup();
  });
});
