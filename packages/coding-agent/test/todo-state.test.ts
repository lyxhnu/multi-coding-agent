import { describe, expect, it } from "vitest";
import { DuplicateTodoIdError, TodoStateStore } from "../src/core/todo/todo-state.ts";

describe("TodoStateStore.applyMerge", () => {
	it("creates new items, defaulting status to pending", () => {
		const store = new TodoStateStore();
		store.applyMerge([{ id: "1", content: "Do the thing" }]);
		expect(store.get("1")).toEqual({ content: "Do the thing", priority: "medium", status: "pending" });
	});

	it("falls back to the id as content when a new item omits content", () => {
		const store = new TodoStateStore();
		store.applyMerge([{ id: "1", status: "in_progress" }]);
		expect(store.get("1")?.content).toBe("1");
	});

	it("updates only status while preserving content for existing items", () => {
		const store = new TodoStateStore();
		store.applyMerge([{ id: "1", content: "Do the thing", status: "pending" }]);
		store.applyMerge([{ id: "1", status: "completed" }]);
		expect(store.get("1")).toEqual({ content: "Do the thing", priority: "medium", status: "completed" });
	});

	it("leaves unrelated existing items untouched", () => {
		const store = new TodoStateStore();
		store.applyMerge([
			{ id: "1", content: "First" },
			{ id: "2", content: "Second" },
		]);
		store.applyMerge([{ id: "1", status: "completed" }]);
		expect(store.get("2")).toEqual({ content: "Second", priority: "medium", status: "pending" });
	});

	it("rejects duplicate ids within the same call", () => {
		const store = new TodoStateStore();
		expect(() =>
			store.applyMerge([
				{ id: "1", content: "a" },
				{ id: "1", content: "b" },
			]),
		).toThrow(DuplicateTodoIdError);
	});
});

describe("TodoStateStore.applyReplace", () => {
	it("fully replaces the existing list", () => {
		const store = new TodoStateStore();
		store.applyMerge([{ id: "1", content: "Old" }]);
		store.applyReplace([{ id: "2", content: "New" }]);
		expect(store.get("1")).toBeUndefined();
		expect(store.get("2")).toEqual({ content: "New", priority: "medium", status: "pending" });
	});

	it("defaults missing content to id and missing status to pending", () => {
		const store = new TodoStateStore();
		store.applyReplace([{ id: "solo" }]);
		expect(store.get("solo")).toEqual({ content: "solo", priority: "medium", status: "pending" });
	});

	it("rejects duplicate ids within the same call", () => {
		const store = new TodoStateStore();
		expect(() =>
			store.applyReplace([
				{ id: "1", content: "a" },
				{ id: "1", content: "b" },
			]),
		).toThrow(DuplicateTodoIdError);
	});
});

describe("TodoStateStore.hasPendingWork", () => {
	it("is false for an empty store", () => {
		expect(new TodoStateStore().hasPendingWork()).toBe(false);
	});

	it("is true when any item is pending or in_progress", () => {
		const store = new TodoStateStore();
		store.applyReplace([
			{ id: "1", content: "done", status: "completed" },
			{ id: "2", content: "wip", status: "in_progress" },
		]);
		expect(store.hasPendingWork()).toBe(true);
	});

	it("is false once every item is completed or cancelled", () => {
		const store = new TodoStateStore();
		store.applyReplace([
			{ id: "1", content: "done", status: "completed" },
			{ id: "2", content: "dropped", status: "cancelled" },
		]);
		expect(store.hasPendingWork()).toBe(false);
	});
});

describe("TodoStateStore.summarize", () => {
	it("reports no tasks for an empty store", () => {
		expect(new TodoStateStore().summarize()).toBe("No tasks currently tracked.");
	});

	it("renders one line per item, in insertion order, with a status tag", () => {
		const store = new TodoStateStore();
		store.applyReplace([
			{ id: "1", content: "First", status: "completed" },
			{ id: "2", content: "Second", status: "in_progress" },
		]);
		expect(store.summarize()).toBe("- [completed] 1: First\n- [in_progress] 2: Second");
	});
});

describe("TodoStateStore round-trip persistence", () => {
	it("restores an equivalent store from toJSON()/fromJSON()", () => {
		const store = new TodoStateStore();
		store.applyReplace([{ id: "1", content: "First", status: "in_progress" }]);
		const restored = TodoStateStore.fromJSON(store.toJSON());
		expect(restored.get("1")).toEqual(store.get("1"));
	});
});
