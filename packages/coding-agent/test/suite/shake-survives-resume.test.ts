import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGGRESSIVE_SHAKE_CONFIG } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A shake has to outlive the process that performed it.
 *
 * pi's session log is append-only and every context build re-derives messages from entries, so
 * editing a stored entry in place would be silently undone on the next load — the freed context
 * would come straight back. Shake therefore records redactions as their own entry and replays them
 * during context construction. These tests pin that down at both layers: the live session view, and
 * a session reopened from disk.
 */

function bigToolResult(tokens: number, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "y".repeat(tokens * 4) }],
		isError: false,
		timestamp,
	};
}

function toolResultText(message: unknown): string {
	const block = (message as ToolResultMessage).content[0];
	return block?.type === "text" ? block.text : "";
}

/**
 * Blob-safe assertion subject. Asserting `toContain` directly against an unshaken 30k-token result
 * dumps the whole blob into the failure output, which buries the actual diff.
 */
function shakeSummary(message: unknown): { shaken: boolean; length: number } {
	const text = toolResultText(message);
	return { shaken: text.startsWith("[shaken:"), length: text.length };
}

describe("shake survives a resume", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function makeHarness(): Promise<Harness> {
		const harness = await createHarness({ settings: { compaction: { enabled: true } } });
		harnesses.push(harness);
		return harness;
	}

	function seed(harness: Harness): void {
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "run it" }],
			timestamp: now - 3_000,
		});
		harness.sessionManager.appendMessage(bigToolResult(30_000, now - 2_000));
		// AGGRESSIVE_SHAKE_CONFIG still protects the most recent 4k tokens, so the oversized result needs
		// something after it to be eligible at all.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "z".repeat(6_000 * 4) }],
			timestamp: now - 1_000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	it("applies to the live context immediately", async () => {
		const harness = await makeHarness();
		seed(harness);

		const saved = await harness.session.shake(AGGRESSIVE_SHAKE_CONFIG, "manual");

		expect(saved).toBeGreaterThan(0);
		const results = harness.session.agent.state.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(shakeSummary(results[0]).shaken).toBe(true);
	});

	it("survives rebuilding the context from entries, which is what a resume does", async () => {
		const harness = await makeHarness();
		seed(harness);
		await harness.session.shake(AGGRESSIVE_SHAKE_CONFIG, "manual");

		// Same derivation a resumed session performs: entries in, messages out. No in-memory shortcut.
		const rebuilt = harness.sessionManager.buildSessionContext().messages;
		const toolResults = rebuilt.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(shakeSummary(toolResults[0])).toMatchObject({ shaken: true });
		expect(shakeSummary(toolResults[0]).length).toBeLessThan(500);
	});

	it("records a shake entry rather than editing the stored message", async () => {
		const harness = await makeHarness();
		seed(harness);
		await harness.session.shake(AGGRESSIVE_SHAKE_CONFIG, "manual");

		const entries = harness.sessionManager.getEntries();
		expect(entries.some((entry) => entry.type === "shake")).toBe(true);
		// The stored tool result keeps its original bytes; only the built context is redacted.
		const stored = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(stored).toBeDefined();
		const summary = shakeSummary((stored as { message: unknown }).message);
		expect(summary.shaken).toBe(false);
		expect(summary.length).toBeGreaterThan(100_000);
	});

	it("emits a shake event carrying the savings", async () => {
		const harness = await makeHarness();
		seed(harness);
		await harness.session.shake(AGGRESSIVE_SHAKE_CONFIG, "manual");

		const shakes = harness.eventsOfType("shake");
		expect(shakes).toHaveLength(1);
		expect(shakes[0].reason).toBe("manual");
		expect(shakes[0].regionCount).toBe(1);
		expect(shakes[0].tokensSaved).toBeGreaterThan(20_000);
	});

	it("reports zero when there is nothing eligible, leaving no entry behind", async () => {
		const harness = await makeHarness();
		harness.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const saved = await harness.session.shake(AGGRESSIVE_SHAKE_CONFIG, "manual");

		expect(saved).toBe(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "shake")).toBe(false);
		expect(harness.eventsOfType("shake")).toHaveLength(0);
	});

	// The suite harness runs in-memory, so a genuine reopen-from-disk needs its own session manager.
	it("still applies after reopening the session file from disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-shake-resume-"));
		dirs.push(dir);
		const manager = SessionManager.create(process.cwd(), dir);
		const now = Date.now();

		manager.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: now - 3_000 });
		const toolResultId = manager.appendMessage(bigToolResult(30_000, now - 2_000));
		// Sessions only flush to disk once an assistant turn exists (SessionManager._persist).
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
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
			timestamp: now - 1_000,
		});
		manager.appendShake([{ kind: "toolResult", targetId: toolResultId, text: "[shaken: gone]" }], 30_000, "manual");

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = SessionManager.open(sessionFile as string, dir);
		const toolResults = reopened.buildSessionContext().messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResultText(toolResults[0])).toBe("[shaken: gone]");
	});
});
