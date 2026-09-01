import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/** Spec 10.5: autoDream Phase 2 — time+session-count gated, lock-guarded, project-only consolidation. */
describe("MemoryStore.maybeConsolidate (autoDream, M9/M5)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function seedSessionNotes(harness: Harness, count: number): void {
		for (let i = 0; i < count; i++) {
			harness.session.memoryStore.writeSessionNote(
				harness.tempDir,
				`session-${i}`,
				`sid${i}aaaaaaaa`,
				`# Session ${i}\n\ndid some work in session ${i}.`,
				`compaction-${i}`,
			);
		}
	}

	it("does not run when fewer than minNewSessions session notes exist", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedSessionNotes(harness, 2);
		const result = await harness.session.memoryStore.maybeConsolidate({
			cwd: harness.tempDir,
			minNewSessions: 3,
			summarize: (notes) => ({
				facts: [{ text: "should not be called", sourceNoteIds: notes.map((note) => note.id) }],
			}),
		});
		expect(result.ran).toBe(false);
		expect(result.reason).toContain("new session note");
	});

	it("consolidates once enough new session notes exist, writing to *project* memory only", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedSessionNotes(harness, 3);
		const result = await harness.session.memoryStore.maybeConsolidate({
			cwd: harness.tempDir,
			minNewSessions: 3,
			summarize: (notes) => ({
				facts: [
					{ text: `Condensed: worked on ${notes.length} sessions.`, sourceNoteIds: notes.map((note) => note.id) },
				],
			}),
		});
		expect(result.ran).toBe(true);
		expect(result.written).toBe(1);

		const projectHits = await harness.session.memoryStore.search("Condensed", "project", harness.tempDir, 10);
		expect(projectHits.length).toBeGreaterThan(0);
		const globalHits = await harness.session.memoryStore.search("Condensed", "global", harness.tempDir, 10);
		expect(globalHits).toHaveLength(0); // spec: "不自动写 global memory"
	});

	it("does not re-run immediately after a successful consolidation (time-gated)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedSessionNotes(harness, 3);
		await harness.session.memoryStore.maybeConsolidate({
			cwd: harness.tempDir,
			minNewSessions: 3,
			summarize: (notes) => ({ facts: [{ text: "first", sourceNoteIds: notes.map((note) => note.id) }] }),
		});
		seedSessionNotes(harness, 3); // 3 more new notes, but the time gate should still block it
		const second = await harness.session.memoryStore.maybeConsolidate({
			cwd: harness.tempDir,
			minNewSessions: 3,
			summarize: (notes) => ({ facts: [{ text: "second", sourceNoteIds: notes.map((note) => note.id) }] }),
		});
		expect(second.ran).toBe(false);
		expect(second.reason).toContain("too soon");
	});

	it("does not double-consolidate the same session notes once the interval has passed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedSessionNotes(harness, 3);
		await harness.session.memoryStore.maybeConsolidate({
			cwd: harness.tempDir,
			minIntervalMs: 0,
			minNewSessions: 3,
			summarize: (notes) => ({ facts: [{ text: "first pass", sourceNoteIds: notes.map((note) => note.id) }] }),
		});
		// No new session notes were added; even with the interval satisfied, there aren't enough *new* ones.
		const second = await harness.session.memoryStore.maybeConsolidate({
			cwd: harness.tempDir,
			minIntervalMs: 0,
			minNewSessions: 3,
			summarize: (notes) => ({ facts: [{ text: "should not run", sourceNoteIds: notes.map((note) => note.id) }] }),
		});
		expect(second.ran).toBe(false);
		expect(second.reason).toContain("new session note");
	});
});
