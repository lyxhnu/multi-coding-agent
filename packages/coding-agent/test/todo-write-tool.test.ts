import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { TodoStateStore } from "../src/core/todo/todo-state.ts";
import { createTodoWriteToolDefinition } from "../src/core/tools/todo-write.ts";

const ctx = {} as ExtensionContext;

describe("todo_write tool", () => {
	it("creates items and reports them back in the summary", async () => {
		const definition = createTodoWriteToolDefinition(process.cwd());
		const result = await definition.execute(
			"call-1",
			{ todos: [{ id: "1", content: "Find the bug" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.content).toEqual([{ type: "text", text: "- [pending] 1: Find the bug" }]);
		expect(result.details?.todos).toEqual([
			{ id: "1", content: "Find the bug", priority: "medium", status: "pending" },
		]);
	});

	it("merges by id across calls by default", async () => {
		const store = new TodoStateStore();
		const definition = createTodoWriteToolDefinition(process.cwd(), { store });
		await definition.execute("call-1", { todos: [{ id: "1", content: "Find the bug" }] }, undefined, undefined, ctx);
		await definition.execute("call-2", { todos: [{ id: "1", status: "completed" }] }, undefined, undefined, ctx);
		expect(store.get("1")).toEqual({ content: "Find the bug", priority: "medium", status: "completed" });
	});

	it("replaces the whole list when merge is false", async () => {
		const store = new TodoStateStore();
		const definition = createTodoWriteToolDefinition(process.cwd(), { store });
		await definition.execute("call-1", { todos: [{ id: "1", content: "Old" }] }, undefined, undefined, ctx);
		await definition.execute(
			"call-2",
			{ merge: false, todos: [{ id: "2", content: "New" }] },
			undefined,
			undefined,
			ctx,
		);
		expect(store.get("1")).toBeUndefined();
		expect(store.get("2")?.content).toBe("New");
	});

	it("rejects duplicate ids in a single call as a normal error (not a crash)", async () => {
		const definition = createTodoWriteToolDefinition(process.cwd());
		await expect(
			definition.execute(
				"call-1",
				{
					todos: [
						{ id: "1", content: "a" },
						{ id: "1", content: "b" },
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/Duplicate todo id/);
	});

	it("reports 'No tasks currently tracked.' when the list is empty", async () => {
		const definition = createTodoWriteToolDefinition(process.cwd());
		const result = await definition.execute("call-1", { todos: [] }, undefined, undefined, ctx);
		expect(result.content).toEqual([{ type: "text", text: "No tasks currently tracked." }]);
	});
});
