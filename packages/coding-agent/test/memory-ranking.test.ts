import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MemoryStore,
	projectMemoryDir,
	projectMemoryFile,
	projectSessionsDir,
} from "../src/core/memory/memory-store.ts";

/**
 * Ranking behavior of MemoryStore.search: recency decay (floored, per-source half-life) and MMR
 * diversity rerank. Block timestamps are controlled by hand-writing MEMORY.md content in the exact
 * format appendEntries produces.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): { store: MemoryStore; root: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-ranking-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	return { store: new MemoryStore(root), root, cwd };
}

function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function block(id: string, iso: string, body: string): string {
	return `\n<!-- id:${id} -->\n## Project memory — ${iso}\n\n${body}\n`;
}

function writeProjectMemory(root: string, cwd: string, content: string): void {
	mkdirSync(projectMemoryDir(root, cwd), { recursive: true });
	writeFileSync(projectMemoryFile(root, cwd), content, "utf-8");
}

describe("MemoryStore.search ranking", () => {
	it("ranks a fresh block above an old one with the same term score", async () => {
		const { store, root, cwd } = createStore();
		writeProjectMemory(
			root,
			cwd,
			block("mem-old00001", isoDaysAgo(100), "alpha oldest-marker") +
				block("mem-new00001", isoDaysAgo(0), "alpha newest-marker"),
		);
		const hits = await store.search("alpha", "project", cwd);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.snippet).toContain("newest-marker");
	});

	it("keeps a strongly matching old block above a weakly matching fresh one (decay floor)", async () => {
		const { store, root, cwd } = createStore();
		const oldIso = isoDaysAgo(100);
		writeProjectMemory(
			root,
			cwd,
			// 10 term hits at >= 70% of their weight always beat 1 fresh hit at 100%.
			block("mem-old00002", oldIso, "alpha ".repeat(10).trim()) +
				block("mem-new00002", isoDaysAgo(0), "alpha fresh-marker"),
		);
		const hits = await store.search("alpha", "project", cwd);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.heading).toContain(oldIso);
	});

	it("decays a session note faster than a curated block of the same age", async () => {
		const { store, root, cwd } = createStore();
		writeProjectMemory(root, cwd, block("mem-cur00001", isoDaysAgo(20), "beta curated-marker"));
		const sessionsDir = projectSessionsDir(root, cwd);
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, `${isoDaysAgo(20).slice(0, 10)}-note-abcdef12.md`), "beta note-marker", "utf-8");
		const hits = await store.search("beta", "project", cwd);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.snippet).toContain("curated-marker");
	});

	it("falls back to file mtime for hand-edited files without markers or dates", async () => {
		const { store, root, cwd } = createStore();
		// No id markers, no ISO timestamp anywhere: the whole file is one block, aged by mtime (now).
		writeProjectMemory(root, cwd, "gamma handwritten note about tooling");
		const hits = await store.search("gamma", "project", cwd);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.score).toBeGreaterThan(0.9);
	});

	it("reads a session note's age from its file name, not its mtime", async () => {
		const { store, root, cwd } = createStore();
		const sessionsDir = projectSessionsDir(root, cwd);
		mkdirSync(sessionsDir, { recursive: true });
		const todayName = `${isoDaysAgo(0).slice(0, 10)}-note-11111111.md`;
		// Both files are written now (same mtime); only the file-name date can separate them.
		writeFileSync(
			join(sessionsDir, `${isoDaysAgo(100).slice(0, 10)}-note-00000000.md`),
			"delta shared fact",
			"utf-8",
		);
		writeFileSync(join(sessionsDir, todayName), "delta shared fact", "utf-8");
		const hits = await store.search("delta", "project", cwd);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.path).toContain(todayName);
	});

	it("surfaces a complementary block over near-duplicates of the top hit (MMR)", async () => {
		const { store, root, cwd } = createStore();
		const iso = isoDaysAgo(0);
		const duplicated = "gamma duplicated fact about the build system pipeline";
		writeProjectMemory(
			root,
			cwd,
			block("mem-dup00001", iso, duplicated) +
				block("mem-dup00002", iso, duplicated) +
				block("mem-dup00003", iso, duplicated) +
				block("mem-dis00001", iso, "gamma unrelated deployment credential rotation schedule"),
		);
		const hits = await store.search("gamma", "project", cwd, 2);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.snippet).toContain("duplicated");
		expect(hits.some((hit) => hit.snippet.includes("deployment"))).toBe(true);
	});
});
