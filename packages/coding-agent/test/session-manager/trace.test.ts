import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { SessionTraceEvent } from "../../src/core/trace.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const tempDirs: string[] = [];

function requestHeader(turn: number, step: number): SessionTraceEvent {
	return {
		type: "request/header",
		data: {
			turn,
			step,
			header: {
				provider: "test",
				model: "trace-model",
				messages: [{ role: "user" }],
			},
		},
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("SessionManager trace entries", () => {
	it("persists trace without advancing or appearing in the conversation tree", () => {
		const dir = join(tmpdir(), `pi-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir);
		const userMessage = userMsg("hello");
		const userId = session.appendMessage(userMessage);
		const traceId = session.appendTrace({ type: "turn/start", data: { turn: 0 } });

		expect(session.getLeafId()).toBe(userId);
		expect(session.getEntry(traceId)).toEqual(expect.objectContaining({ type: "trace", parentId: userId }));
		expect(session.getBranch().map((entry) => entry.id)).toEqual([userId]);
		expect(session.getTree()[0]?.children).toHaveLength(0);
		expect(session.buildSessionContext().messages).toEqual([userMessage]);

		const assistantId = session.appendMessage(assistantMsg("done"));
		session.appendTrace({
			type: "turn/end",
			data: { turn: 0, stopReason: "stop", willRetry: false },
		});
		const file = session.getSessionFile();
		expect(file && existsSync(file)).toBe(true);

		const reopened = SessionManager.open(file!, dir);
		expect(reopened.getLeafId()).toBe(assistantId);
		expect(reopened.getBranch().every((entry) => entry.type !== "trace")).toBe(true);
		expect(reopened.getEntries().filter((entry) => entry.type === "trace")).toHaveLength(2);
	});

	it("selects and carries only trace turns anchored to the chosen branch", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(assistantMsg("root"));

		session.appendTrace({ type: "turn/start", data: { turn: 0 } });
		const branchAUser = session.appendMessage(userMsg("branch A"));
		session.appendTrace(requestHeader(0, 0));
		const branchALeaf = session.appendMessage(assistantMsg("A"));
		session.appendTrace({ type: "turn/end", data: { turn: 0, stopReason: "stop", willRetry: false } });

		session.branch(rootId);
		session.appendTrace({ type: "turn/start", data: { turn: 1 } });
		const branchBUser = session.appendMessage(userMsg("branch B"));
		session.appendTrace(requestHeader(1, 0));
		const branchBLeaf = session.appendMessage(assistantMsg("B"));
		session.appendTrace({ type: "turn/end", data: { turn: 1, stopReason: "stop", willRetry: false } });

		const branchBEntries = session.getBranchWithTrace(branchBLeaf);
		expect(branchBEntries.some((entry) => entry.id === branchAUser || entry.id === branchALeaf)).toBe(false);
		expect(branchBEntries.filter((entry) => entry.type === "trace").map((entry) => entry.event.data.turn)).toEqual([
			1, 1, 1,
		]);
		expect(branchBEntries.filter((entry) => entry.type !== "trace").map((entry) => entry.id)).toEqual([
			rootId,
			branchBUser,
			branchBLeaf,
		]);

		session.createBranchedSession(branchBLeaf);
		expect(session.getEntries().filter((entry) => entry.type === "trace")).toHaveLength(3);
		expect(session.getLeafId()).toBe(branchBLeaf);
	});
});
