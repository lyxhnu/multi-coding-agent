import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AppendOnlyContextManager, AppendOnlyLog, StablePrefix } from "../src/append-only-context.ts";
import type { AgentContext, AgentTool } from "../src/types.ts";

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as Message;
}

function toolResultMessage(isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text: "result" }],
		toolCallId: "c1",
		toolName: "bash",
		isError,
		timestamp: 0,
	};
}

function tool(name: string, description = "d"): AgentTool<any> {
	return { name, label: name, description, parameters: { type: "object" }, execute: async () => ({}) } as never;
}

function contextOf(systemPrompt: string, tools: AgentTool<any>[] = []): AgentContext {
	return { systemPrompt, messages: [], tools };
}

function logTexts(manager: AppendOnlyContextManager): string[] {
	return manager.log.toMessages().map((message) => {
		const content = (message as { content: Array<{ text?: string }> }).content;
		return content[0]?.text ?? "";
	});
}

describe("StablePrefix", () => {
	it("reports a change on first build and none on a rebuild with equal content", () => {
		const prefix = new StablePrefix();
		expect(prefix.build(contextOf("sys", [tool("read")]))).toBe(true);
		// Fresh objects, identical content — the host rebuilds these every turn.
		expect(prefix.build(contextOf("sys", [tool("read")]))).toBe(false);
		expect(prefix.version).toBe(1);
	});

	it("rebuilds when the system prompt changes", () => {
		const prefix = new StablePrefix();
		prefix.build(contextOf("sys"));
		expect(prefix.build(contextOf("other"))).toBe(true);
		expect(prefix.version).toBe(2);
	});

	it("rebuilds when a tool's description changes", () => {
		const prefix = new StablePrefix();
		prefix.build(contextOf("sys", [tool("read", "before")]));
		expect(prefix.build(contextOf("sys", [tool("read", "after")]))).toBe(true);
	});

	it("rebuilds when the tool set changes", () => {
		const prefix = new StablePrefix();
		prefix.build(contextOf("sys", [tool("read")]));
		expect(prefix.build(contextOf("sys", [tool("read"), tool("write")]))).toBe(true);
	});

	it("rebuilds after invalidate()", () => {
		const prefix = new StablePrefix();
		prefix.build(contextOf("sys"));
		prefix.invalidate();
		expect(prefix.built).toBe(false);
		expect(prefix.build(contextOf("sys"))).toBe(true);
	});

	it("throws when read before being built", () => {
		expect(() => new StablePrefix().toContext()).toThrow(/before build/);
	});
});

describe("AppendOnlyLog", () => {
	it("truncates to a prefix and ignores an out-of-range count", () => {
		const log = new AppendOnlyLog();
		log.extend([userMessage("a"), userMessage("b"), userMessage("c")]);
		log.truncate(5);
		expect(log.length).toBe(3);
		log.truncate(2);
		expect(log.length).toBe(2);
		log.truncate(-1);
		expect(log.length).toBe(0);
	});
});

describe("AppendOnlyContextManager.syncMessages", () => {
	it("appends only the new tail on a normal turn", () => {
		const manager = new AppendOnlyContextManager();
		const first = [userMessage("a"), userMessage("b")];
		manager.syncMessages(first);
		const originalSecond = manager.log.entries()[1];

		manager.syncMessages([...first, userMessage("c")]);
		expect(logTexts(manager)).toEqual(["a", "b", "c"]);
		// The already-sent messages keep their identity: nothing was re-serialized.
		expect(manager.log.entries()[1]).toBe(originalSecond);
	});

	it("clears and replays when the array shrinks (compaction)", () => {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([userMessage("a"), userMessage("b"), userMessage("c")]);
		manager.syncMessages([userMessage("summary")]);
		expect(logTexts(manager)).toEqual(["summary"]);
	});

	it("preserves the stable prefix when one message is rewritten in place", () => {
		// The case this mode exists for: shake or a context hook rewrites message 1 of 4. Everything
		// before it is still byte-identical and must not be re-sent.
		const manager = new AppendOnlyContextManager();
		const before = [userMessage("a"), userMessage("b"), userMessage("c"), userMessage("d")];
		manager.syncMessages(before);
		const keptFirst = manager.log.entries()[0];

		const after = [userMessage("a"), userMessage("SHAKEN"), userMessage("c"), userMessage("d")];
		manager.syncMessages(after);

		expect(logTexts(manager)).toEqual(["a", "SHAKEN", "c", "d"]);
		// Message 0 survived untouched; only 1 onward were replayed.
		expect(manager.log.entries()[0]).toBe(keptFirst);
		expect(manager.log.entries()[1]).toBe(after[1]);
	});

	it("keeps the whole log when nothing changed", () => {
		const manager = new AppendOnlyContextManager();
		const messages = [userMessage("a"), userMessage("b")];
		manager.syncMessages(messages);
		const snapshot = manager.log.entries().slice();
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		expect(manager.log.entries()[0]).toBe(snapshot[0]);
		expect(manager.log.entries()[1]).toBe(snapshot[1]);
	});

	it("notices a rewrite of the first message", () => {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		manager.syncMessages([userMessage("REWRITTEN"), userMessage("b")]);
		expect(logTexts(manager)).toEqual(["REWRITTEN", "b"]);
	});

	it("notices a rewrite that only changes a tool result's error flag", () => {
		const manager = new AppendOnlyContextManager();
		const ok = toolResultMessage(false);
		const failed = toolResultMessage(true);
		manager.syncMessages([ok]);
		manager.syncMessages([failed]);
		expect(manager.log.entries()[0]).toBe(failed);
	});

	it("handles a rewrite and an append in the same sync", () => {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		manager.syncMessages([userMessage("a"), userMessage("SHAKEN"), userMessage("c")]);
		expect(logTexts(manager)).toEqual(["a", "SHAKEN", "c"]);
	});

	it("replays everything when the log was cleared directly, leaving the cursor ahead", () => {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		manager.log.clear();
		manager.syncMessages([userMessage("a"), userMessage("b"), userMessage("c")]);
		// The stable count is bounded by the physical log length, so an emptied log replays in full
		// instead of trusting a cursor that no longer describes anything.
		expect(logTexts(manager)).toEqual(["a", "b", "c"]);
	});
});

describe("AppendOnlyContextManager lifecycle", () => {
	it("builds a context from the stable prefix and the log", () => {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([userMessage("a")]);
		const context = manager.build(contextOf("sys", [tool("read")]));
		expect(context.systemPrompt).toBe("sys");
		expect(context.tools?.map((entry) => entry.name)).toEqual(["read"]);
		expect(context.messages).toHaveLength(1);
	});

	it("resets on a model switch but not on the first model seen", () => {
		const manager = new AppendOnlyContextManager();
		manager.noteModel("anthropic", "claude");
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		expect(manager.log.length).toBe(2);

		// Same model again: nothing is thrown away.
		manager.noteModel("anthropic", "claude");
		expect(manager.log.length).toBe(2);

		manager.noteModel("openai", "gpt");
		expect(manager.log.length).toBe(0);
	});

	it("replays from scratch after invalidateForModelChange", () => {
		const manager = new AppendOnlyContextManager();
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		manager.invalidateForModelChange();
		manager.syncMessages([userMessage("a"), userMessage("b")]);
		expect(logTexts(manager)).toEqual(["a", "b"]);
	});

	it("resetSyncCursor clears the log but keeps the prefix snapshot", () => {
		const manager = new AppendOnlyContextManager();
		manager.build(contextOf("sys"));
		const version = manager.prefix.version;
		manager.syncMessages([userMessage("a")]);
		manager.resetSyncCursor();
		expect(manager.log.length).toBe(0);
		expect(manager.prefix.version).toBe(version);
	});
});
