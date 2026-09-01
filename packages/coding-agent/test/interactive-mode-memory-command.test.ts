import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/**
 * Spec 10.5/10.6: "/memory flush [instructions]" and "/memory undo <id>" as interactive slash commands.
 * Exercises InteractiveMode.handleMemoryCommand directly off the prototype (see
 * interactive-mode-status.test.ts for the same "fakeThis" pattern), without needing a full TUI instance.
 */
describe("InteractiveMode.handleMemoryCommand", () => {
	function createFakeThis(overrides: { flushMemoryNow?: ReturnType<typeof vi.fn>; undo?: ReturnType<typeof vi.fn> }) {
		return {
			session: {
				flushMemoryNow: overrides.flushMemoryNow ?? vi.fn(),
				memoryStore: { undo: overrides.undo ?? vi.fn() },
			},
			sessionManager: { getCwd: () => "/fake/cwd" },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
	}

	function callHandleMemoryCommand(fakeThis: unknown, text: string): Promise<void> {
		return (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, text);
	}

	test('"/memory" alone (no subcommand) defaults to flush', async () => {
		const flushMemoryNow = vi.fn().mockResolvedValue({ attempted: true, written: 1, skipped: 0 });
		const fakeThis = createFakeThis({ flushMemoryNow });
		await callHandleMemoryCommand(fakeThis, "/memory");
		expect(flushMemoryNow).toHaveBeenCalledWith(undefined);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(expect.stringContaining("Wrote 1 memory entry"));
	});

	test('"/memory flush" with custom instructions passes them through to flushMemoryNow', async () => {
		const flushMemoryNow = vi.fn().mockResolvedValue({ attempted: true, written: 1, skipped: 0 });
		const fakeThis = createFakeThis({ flushMemoryNow });
		await callHandleMemoryCommand(fakeThis, "/memory flush remember the build command");
		expect(flushMemoryNow).toHaveBeenCalledWith("remember the build command");
	});

	test('"/memory flush" reports a warning (not an error) when nothing was attempted', async () => {
		const flushMemoryNow = vi
			.fn()
			.mockResolvedValue({ attempted: false, written: 0, skipped: 0, warning: "nothing new to summarize yet" });
		const fakeThis = createFakeThis({ flushMemoryNow });
		await callHandleMemoryCommand(fakeThis, "/memory flush");
		expect(fakeThis.showWarning).toHaveBeenCalledWith("nothing new to summarize yet");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test('"/memory flush" surfaces a thrown error via showError', async () => {
		const flushMemoryNow = vi.fn().mockRejectedValue(new Error("no model configured"));
		const fakeThis = createFakeThis({ flushMemoryNow });
		await callHandleMemoryCommand(fakeThis, "/memory flush");
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("no model configured"));
	});
	test("E05/M03 shows a rejected flush without presenting it as a successful write", async () => {
		const fakeThis = createFakeThis({
			flushMemoryNow: vi.fn().mockResolvedValue({
				attempted: true,
				written: 0,
				skipped: 1,
				reasons: ["secret_pattern"],
				warning: "1 candidate(s) were discarded by the secret filter",
			}),
		});
		await callHandleMemoryCommand(fakeThis, "/memory flush");
		expect(fakeThis.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Wrote 1"));
		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("discarded"));
	});

	test('"/memory undo <id>" defaults to project scope', async () => {
		const undo = vi.fn().mockReturnValue(true);
		const fakeThis = createFakeThis({ undo });
		await callHandleMemoryCommand(fakeThis, "/memory undo mem-abc123");
		expect(undo).toHaveBeenCalledWith("project", "/fake/cwd", "mem-abc123");
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			expect.stringContaining('Undid memory entry "mem-abc123" (project)'),
		);
	});

	test('"/memory undo global <id>" targets the global memory file', async () => {
		const undo = vi.fn().mockReturnValue(true);
		const fakeThis = createFakeThis({ undo });
		await callHandleMemoryCommand(fakeThis, "/memory undo global mem-xyz789");
		expect(undo).toHaveBeenCalledWith("global", undefined, "mem-xyz789");
	});

	test('"/memory undo <id>" reports (not throws) when the id is unknown', async () => {
		const undo = vi.fn().mockReturnValue(false);
		const fakeThis = createFakeThis({ undo });
		await callHandleMemoryCommand(fakeThis, "/memory undo does-not-exist");
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			expect.stringContaining('No project memory entry found with id "does-not-exist"'),
		);
	});

	test('"/memory undo" with no id shows a usage warning instead of calling undo()', async () => {
		const undo = vi.fn();
		const fakeThis = createFakeThis({ undo });
		await callHandleMemoryCommand(fakeThis, "/memory undo");
		expect(undo).not.toHaveBeenCalled();
		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("Usage: /memory undo"));
	});

	test('"/memory" with an unrecognized subcommand shows a usage warning', async () => {
		const fakeThis = createFakeThis({});
		await callHandleMemoryCommand(fakeThis, "/memory bogus");
		expect(fakeThis.showWarning).toHaveBeenCalledWith(expect.stringContaining("Usage: /memory flush"));
	});
});
