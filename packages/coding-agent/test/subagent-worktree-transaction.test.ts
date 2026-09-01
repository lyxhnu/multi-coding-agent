import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentCoordinator } from "../src/core/subagents/subagent-coordinator.ts";
import { TaskManager } from "../src/core/tasks/task-manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRepository(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-worktree-"));
	roots.push(cwd);
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "tracked.txt"), "before\n", "utf-8");
	execFileSync("git", ["add", "tracked.txt"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.test", "commit", "-m", "initial"], {
		cwd,
		stdio: "ignore",
	});
	return cwd;
}

describe("SubagentCoordinator worktree transactions", () => {
	const completedResult = {
		status: "completed" as const,
		submission: {
			status: "completed" as const,
			summary: "done",
			findings: [],
			changes: [{ path: "tracked.txt", action: "modified" as const, summary: "updated" }],
			verification: [],
		},
	};

	it("applies tracked and untracked changes back to the parent checkout", async () => {
		const cwd = createRepository();
		const tasks = new TaskManager();
		const coordinator = new SubagentCoordinator(
			tasks,
			async (request) => {
				writeFileSync(join(request.cwd, "tracked.txt"), "after\n", "utf-8");
				writeFileSync(join(request.cwd, "new.txt"), "new\n", "utf-8");
				return completedResult;
			},
			{ depth: 0, cwd },
		);
		const handle = coordinator.spawn({
			agentType: "general-purpose",
			description: "change files",
			prompt: "change files",
			isolation: "worktree",
		});
		const snapshot = await tasks.awaitSettled(handle.taskId);

		expect(snapshot.status).toBe("completed");
		expect(readFileSync(join(cwd, "tracked.txt"), "utf-8").replaceAll("\r\n", "\n")).toBe("after\n");
		expect(readFileSync(join(cwd, "new.txt"), "utf-8").replaceAll("\r\n", "\n")).toBe("new\n");
	});

	it("fails before spawning when worktree isolation cannot be created", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-no-git-"));
		roots.push(cwd);
		let ran = false;
		const coordinator = new SubagentCoordinator(
			new TaskManager(),
			async () => {
				ran = true;
				return completedResult;
			},
			{ depth: 0, cwd },
		);

		expect(() =>
			coordinator.spawn({
				agentType: "general-purpose",
				description: "must isolate",
				prompt: "must isolate",
				isolation: "worktree",
			}),
		).toThrow("Could not create isolated git worktree");
		expect(ran).toBe(false);
	});

	it("does not apply changes from a blocked subagent", async () => {
		const cwd = createRepository();
		const tasks = new TaskManager();
		const coordinator = new SubagentCoordinator(
			tasks,
			async (request) => {
				writeFileSync(join(request.cwd, "tracked.txt"), "blocked change\n", "utf-8");
				return {
					status: "blocked",
					submission: {
						status: "blocked",
						summary: "could not verify",
						blocker: "missing dependency",
						findings: [],
					},
				};
			},
			{ depth: 0, cwd },
		);
		const handle = coordinator.spawn({
			agentType: "general-purpose",
			description: "blocked change",
			prompt: "change files",
			isolation: "worktree",
		});
		const snapshot = await tasks.awaitSettled(handle.taskId);

		expect(snapshot.status).toBe("blocked");
		expect(readFileSync(join(cwd, "tracked.txt"), "utf-8").replaceAll("\r\n", "\n")).toBe("before\n");
	});

	it("resumes from the prior structured result without text protocol parsing", async () => {
		const cwd = createRepository();
		const tasks = new TaskManager();
		const prompts: string[] = [];
		const coordinator = new SubagentCoordinator(
			tasks,
			async (request) => {
				prompts.push(request.prompt);
				return completedResult;
			},
			{ depth: 0, cwd },
		);
		const first = coordinator.spawn({
			agentType: "explore",
			description: "first",
			prompt: "inspect",
		});
		await tasks.awaitSettled(first.taskId);
		const second = coordinator.spawn({
			agentType: "explore",
			description: "resume",
			prompt: "continue",
			resumeFrom: first.taskId,
		});
		await tasks.awaitSettled(second.taskId);

		expect(prompts[1]).toContain('"submission":{"status":"completed"');
		expect(prompts[1]).not.toContain("<subagent_result>");
	});
});
