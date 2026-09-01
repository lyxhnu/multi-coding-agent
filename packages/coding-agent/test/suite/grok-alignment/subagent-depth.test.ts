import { afterEach, describe, expect, it } from "vitest";
import { MAX_SUBAGENT_DEPTH } from "../../../src/core/subagents/subagent-coordinator.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Spec 8: MAX_SUBAGENT_DEPTH = 1. Hard gate: "subagent depth > 1" must stay at 0 — task/get_task_output/
 * kill_task must be *physically removed* (not merely deactivated) once a session is at MAX_SUBAGENT_DEPTH,
 * so a subagent can never spawn a grandchild subagent. See subagent-task-tool.test.ts for the full
 * task()-tool-level coverage; this file isolates the depth invariant itself.
 */
describe("MAX_SUBAGENT_DEPTH (M9 eval: subagent-depth)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is exactly 1", () => {
		expect(MAX_SUBAGENT_DEPTH).toBe(1);
	});

	it("depth 0 (root session) can spawn subagents: task/get_task_output/kill_task are all present", async () => {
		const harness = await createHarness({ subagentDepth: 0 });
		harnesses.push(harness);
		const names = harness.session.getAllTools().map((t) => t.name);
		expect(names).toContain("task");
		expect(names).toContain("get_task_output");
		expect(names).toContain("kill_task");
	});

	it("hard gate: depth === MAX_SUBAGENT_DEPTH physically removes task/get_task_output/kill_task, not just deactivates them", async () => {
		const harness = await createHarness({ subagentDepth: MAX_SUBAGENT_DEPTH });
		harnesses.push(harness);
		const names = harness.session.getAllTools().map((t) => t.name);
		expect(names).not.toContain("task");
		expect(names).not.toContain("get_task_output");
		expect(names).not.toContain("kill_task");
		// Physically removed means absent from the *registry*, not merely inactive:
		expect(harness.session.getActiveToolNames()).not.toContain("task");
	});

	it("hard gate: depth beyond MAX_SUBAGENT_DEPTH is equally locked out (monotonic, not an off-by-one)", async () => {
		const harness = await createHarness({ subagentDepth: MAX_SUBAGENT_DEPTH + 1 });
		harnesses.push(harness);
		const names = harness.session.getAllTools().map((t) => t.name);
		expect(names).not.toContain("task");
	});
});
