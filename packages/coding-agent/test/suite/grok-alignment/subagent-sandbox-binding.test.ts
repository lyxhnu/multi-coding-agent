import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Spec 12: "subagent read-only使用read-only profile，subagent writer使用workspace profile". A
 * "read-only" capability_mode subagent never gets the `bash`/`edit`/`write` tools at all (see
 * _capabilityModeToolNames in agent-session.ts) — a *stronger* guarantee than the sandbox alone, and
 * one that makes "prove the read-only sandbox profile blocks a write" unreachable through the tool
 * surface (there is no tool to attempt the write with). This file instead verifies the "workspace
 * profile" binding that a writer subagent *does* get: writes inside the workspace succeed, writes
 * outside it (e.g. into the OS temp dir) are confined/denied by the sandbox. Real OS sandbox backend;
 * only runs on darwin/linux (see sandbox-manager.test.ts for portable, pure-logic coverage).
 */
describe("subagent sandbox profile binding (spec 12)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const sandboxed = process.platform === "darwin" || process.platform === "linux";
	const itSandboxed = sandboxed ? it : it.skip;

	itSandboxed(
		"a general-purpose (writer) subagent can write within its own workspace via bash",
		async () => {
			const harness = await createHarness({ settings: { permissions: { mode: "bypassPermissions" } } });
			harnesses.push(harness);
			const markerPath = join(harness.tempDir, "should-exist.txt");

			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("task", {
						description: "write a file",
						prompt: `run: touch ${markerPath}`,
						subagent_type: "general-purpose",
						run_in_background: false,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${markerPath}` }), { stopReason: "toolUse" }),
				fauxAssistantMessage("wrote the file"),
				fauxAssistantMessage("subagent reported success"),
			]);
			await harness.session.prompt("delegate a write to a general-purpose subagent");

			expect(existsSync(markerPath)).toBe(true);
		},
		20_000,
	);

	itSandboxed(
		"the workspace sandbox profile confines a subagent's writes outside common scratch dirs",
		async () => {
			const harness = await createHarness({ settings: { permissions: { mode: "bypassPermissions" } } });
			harnesses.push(harness);
			// Genuinely outside both the workspace *and* the sandbox's allowed scratch dirs (/tmp, /private/tmp,
			// /private/var/folders) — unlike harness.tempDir's own parent, which macOS puts under
			// /var/folders and would therefore be covered by that scratch-dir allowance.
			const outsidePath = join(process.cwd(), `pi-sandbox-escape-${Date.now()}.txt`);
			try {
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("task", {
							description: "try to write outside the workspace",
							prompt: `run: touch ${outsidePath}`,
							subagent_type: "general-purpose",
							run_in_background: false,
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${outsidePath}` }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("could not write outside the workspace"),
					fauxAssistantMessage("subagent reported it could not write outside the workspace"),
				]);
				await harness.session.prompt("delegate a write outside the workspace to a general-purpose subagent");

				expect(existsSync(outsidePath)).toBe(false);
			} finally {
				rmSync(outsidePath, { force: true });
			}
		},
		20_000,
	);
});
