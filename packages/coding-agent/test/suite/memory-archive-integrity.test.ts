import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMemory } from "../../src/core/memory/consolidation.ts";
import { validateMemoryExtraction } from "../../src/core/memory/extraction.ts";
import { MemoryStore, projectMemoryDir, projectMemoryFile } from "../../src/core/memory/memory-store.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("memory-context-integrity: archive transaction", () => {
	it("E02 retains sourced facts across stores and honors undo after restart", async () => {
		const { store, options } = await seed();
		const result = await store.maybeConsolidate({
			...options,
			summarize: (sources) => ({
				facts: [{ text: "Project atomic commit rule", sourceNoteIds: sources.map((note) => note.id) }],
			}),
		});
		const next = new MemoryStore(store.rootDir);
		next.appendProject(options.cwd, ["Other review rule remains valid"]);
		expect(await next.search("atomic commit", "project", options.cwd)).not.toHaveLength(0);
		expect(next.undo("project", options.cwd, `mem-${result.batchId}-0`)).toBe(true);
		const resumed = new MemoryStore(store.rootDir);
		expect(resumed.get(projectMemoryFile(store.rootDir, options.cwd))).not.toContain("Project atomic commit rule");
		expect(resumed.get(projectMemoryFile(store.rootDir, options.cwd))).toContain("Other review rule");
	});
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.useRealTimers();
		for (const h of harnesses.splice(0)) await h.cleanup();
	});
	async function seed(sessions = ["a", "b", "c"]) {
		const h = await createHarness();
		harnesses.push(h);
		const store = h.session.memoryStore;
		const notes = sessions.map((session, index) =>
			store.writeSessionNote(
				h.tempDir,
				"note",
				session,
				`# Date heading\n\nDecision ${index}: use atomic writes for project state.`,
				`compact-${index}`,
			),
		);
		return { h, store, notes, options: { cwd: h.tempDir, minIntervalMs: 0 } };
	}
	it.each([
		{ facts: [{ text: "", sourceNoteIds: ["a"] }] },
		{ facts: [{ text: "ok", sourceNoteIds: [] }] },
		{ facts: [{ text: "ok", sourceNoteIds: ["forged"] }] },
		{ facts: [], extra: true },
		{ facts: [{ text: "ok", sourceNoteIds: ["a"], extra: true }] },
	])("D05 rejects malformed or forged extraction %j", (value) => {
		expect(() => validateMemoryExtraction(value, new Set(["a"]))).toThrow("invalid_memory_extraction");
	});
	it("D01 supplies full note bodies and commits source-linked durable facts", async () => {
		const { store, options, h } = await seed();
		const result = await store.maybeConsolidate({
			...options,
			summarize: (sources) => {
				expect(sources.every((note) => note.content.includes("use atomic writes"))).toBe(true);
				return {
					facts: [{ text: "Project state uses atomic writes.", sourceNoteIds: sources.map((note) => note.id) }],
				};
			},
		});
		expect(result).toMatchObject({ ran: true, written: 1 });
		expect(readFileSync(projectMemoryFile(store.rootDir, h.tempDir), "utf8")).toContain("source-notes:");
	});
	it("D05 rejects invalid model JSON without advancing state or giving extraction execution tools", async () => {
		const { store, options, h } = await seed();
		h.setResponses([
			(context) => {
				expect(context.tools ?? []).toEqual([]);
				expect(JSON.stringify(context.messages)).toContain("use atomic writes");
				return fauxAssistantMessage("not JSON");
			},
		]);
		await expect(
			store.maybeConsolidate({
				...options,
				summarize: (notes, signal) =>
					extractMemory(notes, h.getModel(), { signal, maxTokens: 2000, apiKey: "faux-key" }, streamSimple),
			}),
		).rejects.toThrow("invalid_memory_extraction");
		expect(existsSync(join(projectMemoryDir(store.rootDir, h.tempDir), ".dream-state.json"))).toBe(false);
	});
	it("D02/D03 snapshots do not overwrite and session thresholds count distinct sessions", async () => {
		const { store, options, notes } = await seed(["a", "a", "a"]);
		expect(new Set(notes.map((note) => note.path)).size).toBe(3);
		const result = await store.maybeConsolidate({
			...options,
			summarize: () => {
				throw new Error("must not run");
			},
		});
		expect(result).toMatchObject({ ran: false });
		expect(result.reason).toContain("only 1");
	});
	it("D04/D05/K01 valid empty output commits watermarks without an empty fact", async () => {
		const { store, options, h } = await seed();
		expect(await store.maybeConsolidate({ ...options, summarize: () => ({ facts: [] }) })).toMatchObject({
			reason: "processed_no_facts",
			written: 0,
		});
		expect(existsSync(projectMemoryFile(store.rootDir, h.tempDir))).toBe(false);
		expect(
			(
				await store.maybeConsolidate({
					...options,
					summarize: () => {
						throw new Error("replayed");
					},
				})
			).ran,
		).toBe(false);
	});
	it("D07 serializes overlapping calls across store instances", async () => {
		const { store, options } = await seed();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = store.maybeConsolidate({
			...options,
			summarize: async () => {
				await gate;
				return { facts: [] };
			},
		});
		const other = await new MemoryStore(store.rootDir).maybeConsolidate({
			...options,
			summarize: () => {
				throw new Error("concurrent");
			},
		});
		expect(other.reason).toContain("lock held");
		release();
		await pending;
	});
	it("D08 retries after a state-write failure without appending duplicate facts", async () => {
		const { store, options, h } = await seed();
		const statePath = join(projectMemoryDir(store.rootDir, h.tempDir), ".dream-state.json");
		await expect(
			store.maybeConsolidate({
				...options,
				summarize: (sources) => {
					mkdirSync(statePath);
					return { facts: [{ text: "Durable atomic state rule", sourceNoteIds: sources.map((note) => note.id) }] };
				},
			}),
		).rejects.toThrow();
		rmSync(statePath, { recursive: true });
		const recovered = await new MemoryStore(store.rootDir).maybeConsolidate({
			...options,
			summarize: () => {
				throw new Error("should recover committed batch");
			},
		});
		expect(recovered.ran).toBe(true);
		expect(
			readFileSync(projectMemoryFile(store.rootDir, h.tempDir), "utf8").split("Durable atomic state rule"),
		).toHaveLength(2);
	});
	it("D06 cancellation and unsafe output do not advance state or leak locks", async () => {
		const { store, options, h } = await seed();
		const controller = new AbortController();
		await expect(
			store.maybeConsolidate({
				...options,
				signal: controller.signal,
				summarize: () => {
					controller.abort();
					return { facts: [] };
				},
			}),
		).rejects.toThrow();
		await expect(
			store.maybeConsolidate({
				...options,
				summarize: (sources) => ({ facts: [{ text: "API_KEY=blocked-test", sourceNoteIds: [sources[0].id] }] }),
			}),
		).rejects.toThrow("unsafe_memory_extraction");
		expect(existsSync(join(projectMemoryDir(store.rootDir, h.tempDir), ".dream-state.json"))).toBe(false);
		expect((await store.maybeConsolidate({ ...options, summarize: () => ({ facts: [] }) })).ran).toBe(true);
	});
	it("D09/D10 selects complete bounded notes and refuses changed sources", async () => {
		const { store, options } = await seed();
		await expect(
			store.maybeConsolidate({
				...options,
				inputFits: (sources) => sources.length <= 1,
				summarize: (sources) => {
					expect(sources).toHaveLength(1);
					writeFileSync(sources[0].path, `${readFileSync(sources[0].path, "utf8")}\nEdited during extraction`);
					return { facts: [] };
				},
			}),
		).rejects.toThrow("memory_source_changed");
		expect(
			(await store.maybeConsolidate({ ...options, inputFits: () => false, summarize: () => ({ facts: [] }) }))
				.reason,
		).toBe("memory_input_budget");
	});
	it("D11 preserves unprocessed old notes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { store, options, notes } = await seed();
		vi.setSystemTime(Date.now() + 200 * 86400000);
		const before = notes.map((note) => readFileSync(join(store.rootDir, note.path!), "utf8"));
		expect(store.degradeSessionNotes(options.cwd).degraded).toBe(0);
		expect(notes.map((note) => readFileSync(join(store.rootDir, note.path!), "utf8"))).toEqual(before);
	});
	it("D11/D12 processed aging preserves the processed watermark", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { store, options } = await seed();
		await store.maybeConsolidate({ ...options, summarize: () => ({ facts: [] }) });
		vi.setSystemTime(Date.now() + 200 * 86400000);
		expect(store.degradeSessionNotes(options.cwd).degraded).toBe(3);
		expect(
			(
				await store.maybeConsolidate({
					...options,
					summarize: () => {
						throw new Error("must not extract aged notes again");
					},
				})
			).ran,
		).toBe(false);
	});
	it("D03 interval gating is independent of new-session count", async () => {
		const { store, options } = await seed();
		await store.maybeConsolidate({ ...options, summarize: () => ({ facts: [] }) });
		for (const id of ["new-a", "new-b", "new-c"])
			store.writeSessionNote(options.cwd, "new", id, "Project decisions use review", id);
		expect(
			(
				await store.maybeConsolidate({
					cwd: options.cwd,
					summarize: () => {
						throw new Error("interval must block");
					},
				})
			).reason,
		).toContain("too soon");
	});
	it("D02 stable snapshot identity survives a renamed session", async () => {
		const { store, options, notes } = await seed(["a"]);
		expect(
			store.writeSessionNote(
				options.cwd,
				"renamed",
				"a",
				"# Date heading\n\nDecision 0: use atomic writes for project state.",
				"compact-0",
			).path,
		).toBe(notes[0].path);
	});
	it("D09 rechecks the effective view when revocations change without a note-body edit", async () => {
		const { store, options, h } = await seed();
		await expect(
			store.maybeConsolidate({
				...options,
				summarize: (sources) => {
					writeFileSync(`${sources[0].path}.tombstones.json`, JSON.stringify([""]));
					return { facts: [] };
				},
			}),
		).rejects.toThrow("memory_source_changed");
		expect(existsSync(join(projectMemoryDir(store.rootDir, h.tempDir), ".dream-state.json"))).toBe(false);
	});
	it("D06 aborts a timed extraction and releases its lock without advancing state", async () => {
		const { store, options, h } = await seed();
		vi.useFakeTimers();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		let stopped = false;
		const pending = store.maybeConsolidate({
			...options,
			signal: controller.signal,
			summarize: (_sources, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							stopped = true;
							reject(new Error("cancelled"));
						},
						{ once: true },
					);
				}),
		});
		const rejected = expect(pending).rejects.toThrow("cancelled");
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		clearTimeout(timer);
		expect(stopped).toBe(true);
		expect(existsSync(join(projectMemoryDir(store.rootDir, h.tempDir), ".dream-state.json"))).toBe(false);
		expect((await store.maybeConsolidate({ ...options, summarize: () => ({ facts: [] }) })).ran).toBe(true);
	});
});
