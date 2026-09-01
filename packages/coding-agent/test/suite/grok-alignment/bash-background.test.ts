import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { TaskManager } from "../../../src/core/tasks/task-manager.ts";
import { type BashOperations, createBashToolDefinition } from "../../../src/core/tools/bash.ts";

const ctx = {} as ExtensionContext;

function delayedOps(ms: number, exitCode: number | null = 0): BashOperations {
	return {
		exec: (_command, _cwd, { onData, signal }) =>
			new Promise((resolve, reject) => {
				onData(Buffer.from("HEAD\n"));
				const timer = setTimeout(() => {
					onData(Buffer.from("TAIL\n"));
					resolve({ exitCode });
				}, ms);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(new Error("aborted"));
				});
			}),
	};
}

describe("bash tool is_background", () => {
	it("returns a task id immediately instead of blocking", async () => {
		const taskManager = new TaskManager();
		const definition = createBashToolDefinition(process.cwd(), {
			operations: delayedOps(200),
			taskManager,
			exposeSessionEnvironment: false,
		});
		const start = Date.now();
		const result = await definition.execute(
			"call-1",
			{ command: "sleep 0.2", is_background: true },
			undefined,
			undefined,
			ctx,
		);
		expect(Date.now() - start).toBeLessThan(150);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Started background task");
		const idMatch = text.match(/task ([0-9a-f-]+)/);
		expect(idMatch).not.toBeNull();
	});

	it("throws a clear error when no task manager is configured", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: delayedOps(10),
			exposeSessionEnvironment: false,
		});
		await expect(
			definition.execute("call-1", { command: "echo hi", is_background: true }, undefined, undefined, ctx),
		).rejects.toThrow(/task manager/i);
	});

	it("the background task's output and completion are visible via TaskManager", async () => {
		const taskManager = new TaskManager();
		const definition = createBashToolDefinition(process.cwd(), {
			operations: delayedOps(20),
			taskManager,
			exposeSessionEnvironment: false,
		});
		const result = await definition.execute(
			"call-1",
			{ command: "echo hi", is_background: true },
			undefined,
			undefined,
			ctx,
		);
		const text = (result.content[0] as { text: string }).text;
		const taskId = text.match(/task ([0-9a-f-]+)/)?.[1] as string;
		const waitResult = await taskManager.wait([taskId], { timeoutMs: 1000 });
		expect(waitResult.snapshots[0]?.status).toBe("completed");
		expect(taskManager.read(taskId)?.text).toContain("HEAD");
		expect(taskManager.read(taskId)?.text).toContain("TAIL");
	});
});

describe("bash tool autoBackgroundOnTimeout", () => {
	it("moves a slow foreground command to the background instead of killing it", async () => {
		const taskManager = new TaskManager();
		const definition = createBashToolDefinition(process.cwd(), {
			operations: delayedOps(300),
			taskManager,
			autoBackgroundOnTimeout: true,
			foregroundBlockBudgetMs: 30,
			exposeSessionEnvironment: false,
		});
		const result = await definition.execute("call-1", { command: "sleep 0.3" }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("moved to background");
	});

	it("returns the final result normally when the command finishes within budget", async () => {
		const taskManager = new TaskManager();
		const definition = createBashToolDefinition(process.cwd(), {
			operations: delayedOps(10),
			taskManager,
			autoBackgroundOnTimeout: true,
			foregroundBlockBudgetMs: 500,
			exposeSessionEnvironment: false,
		});
		const result = await definition.execute("call-1", { command: "echo hi" }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("HEAD");
		expect(text).toContain("TAIL");
		expect(text).not.toContain("moved to background");
	});

	it("does not change behavior when autoBackgroundOnTimeout is not set (default)", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: delayedOps(5),
			exposeSessionEnvironment: false,
		});
		const result = await definition.execute("call-1", { command: "echo hi" }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("HEAD");
	});
});
