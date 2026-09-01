import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	collectShakenIndex,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
	type ShakeEntry,
	type ShakeRedaction,
} from "../../src/core/session-manager.ts";

const TS = "2025-01-01T00:00:00Z";

function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: TS, message: { role: "user", content: text, timestamp: 1 } };
}

function toolResultEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: `call-${id}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
	return { type: "message", id, parentId, timestamp: TS, message };
}

function shakeEntry(id: string, parentId: string | null, redactions: ShakeRedaction[]): ShakeEntry {
	return { type: "shake", id, parentId, timestamp: TS, redactions, tokensSaved: 100, reason: "manual" };
}

function compactionEntry(id: string, parentId: string | null, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: TS,
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

function toolResultText(entry: SessionEntry): string {
	const message = (entry as SessionMessageEntry).message as ToolResultMessage;
	const block = message.content[0];
	return block.type === "text" ? block.text : "";
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as AssistantMessage;
}

describe("buildContextEntries shake replay", () => {
	it("replays a tool-result redaction into the built context", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "hi"),
			toolResultEntry("t1", "u1", "ORIGINAL OUTPUT"),
			shakeEntry("s1", "t1", [{ kind: "toolResult", targetId: "t1", text: "[shaken]" }]),
		];
		const built = buildContextEntries(entries, "s1");
		const target = built.find((entry) => entry.id === "t1");
		expect(target).toBeDefined();
		expect(toolResultText(target as SessionEntry)).toBe("[shaken]");
	});

	it("does not mutate the stored entry", () => {
		const stored = toolResultEntry("t1", "u1", "ORIGINAL OUTPUT");
		const entries: SessionEntry[] = [
			userEntry("u1", null, "hi"),
			stored,
			shakeEntry("s1", "t1", [{ kind: "toolResult", targetId: "t1", text: "[shaken]" }]),
		];
		buildContextEntries(entries, "s1");
		expect(toolResultText(stored)).toBe("ORIGINAL OUTPUT");
	});

	it("keeps the shake entry out of the LLM context", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "hi"),
			shakeEntry("s1", "u1", [{ kind: "toolResult", targetId: "missing", text: "[shaken]" }]),
		];
		const context = buildSessionContext(entries, "s1");
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0].role).toBe("user");
	});

	it("lets a later shake of the same target win", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "hi"),
			toolResultEntry("t1", "u1", "ORIGINAL"),
			shakeEntry("s1", "t1", [{ kind: "toolResult", targetId: "t1", text: "[first]" }]),
			shakeEntry("s2", "s1", [{ kind: "toolResult", targetId: "t1", text: "[second]" }]),
		];
		const built = buildContextEntries(entries, "s2");
		expect(toolResultText(built.find((entry) => entry.id === "t1") as SessionEntry)).toBe("[second]");
	});

	it("applies redactions to entries that survived compaction", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "old"),
			toolResultEntry("t1", "u1", "DROPPED BY COMPACTION"),
			userEntry("u2", "t1", "kept"),
			toolResultEntry("t2", "u2", "KEPT OUTPUT"),
			compactionEntry("c1", "t2", "u2"),
			shakeEntry("s1", "c1", [
				{ kind: "toolResult", targetId: "t1", text: "[shaken-dropped]" },
				{ kind: "toolResult", targetId: "t2", text: "[shaken-kept]" },
			]),
		];
		const built = buildContextEntries(entries, "s1");
		// t1 was summarized away, so its redaction finds no target and is skipped without error.
		expect(built.find((entry) => entry.id === "t1")).toBeUndefined();
		expect(toolResultText(built.find((entry) => entry.id === "t2") as SessionEntry)).toBe("[shaken-kept]");
	});

	it("ignores shake entries on a sibling branch", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "root"),
			toolResultEntry("t1", "u1", "ORIGINAL"),
			shakeEntry("s1", "t1", [{ kind: "toolResult", targetId: "t1", text: "[shaken]" }]),
			userEntry("u2", "t1", "other branch"),
		];
		const built = buildContextEntries(entries, "u2");
		expect(toolResultText(built.find((entry) => entry.id === "t1") as SessionEntry)).toBe("ORIGINAL");
	});
});

describe("collectShakenIndex", () => {
	it("indexes every redaction along the path", () => {
		const entries: SessionEntry[] = [
			toolResultEntry("t1", null, "a"),
			shakeEntry("s1", "t1", [
				{ kind: "toolResult", targetId: "t1", text: "[x]" },
				{ kind: "block", targetId: "u9", blockIndex: 1, text: "[y]" },
			]),
		];
		const index = collectShakenIndex(entries);
		expect(index.has("t1")).toBe(true);
		expect(index.get("u9")?.has(1)).toBe(true);
	});
});

describe("shake durability across reload", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-shake-"));
		dirs.push(dir);
		return dir;
	}

	// The reason redactions are persisted as their own entry rather than edited in place: the session
	// log is append-only, so an in-place edit would be lost here and the freed context with it.
	it("still applies after the session is reloaded from disk", () => {
		const dir = tempDir();
		const manager = SessionManager.create(process.cwd(), dir);

		manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		const toolResultId = manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "ORIGINAL OUTPUT" }],
			isError: false,
			timestamp: 1,
		});
		// Sessions only flush to disk once an assistant turn exists (see SessionManager._persist), so a
		// durability test has to contain one.
		manager.appendMessage(assistantMessage("done"));
		manager.appendShake([{ kind: "toolResult", targetId: toolResultId, text: "[shaken]" }], 1234, "manual");

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reloaded = SessionManager.open(sessionFile as string, dir);
		const context = reloaded.buildSessionContext();
		const toolResult = context.messages.find((message) => message.role === "toolResult") as ToolResultMessage;
		const block = toolResult.content[0];
		expect(block.type === "text" ? block.text : "").toBe("[shaken]");
	});

	it("records the shake entry with its savings and reason", () => {
		const dir = tempDir();
		const manager = SessionManager.create(process.cwd(), dir);
		manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		manager.appendMessage(assistantMessage("done"));
		manager.appendShake([{ kind: "toolResult", targetId: "nope", text: "[shaken]" }], 4321, "threshold");

		const reloaded = SessionManager.open(manager.getSessionFile() as string, dir);
		const shake = reloaded.getEntries().find((entry) => entry.type === "shake") as ShakeEntry;
		expect(shake.tokensSaved).toBe(4321);
		expect(shake.reason).toBe("threshold");
		expect(shake.redactions).toHaveLength(1);
	});
});
