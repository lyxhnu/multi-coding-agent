import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	degradeNoteContent,
	extractKeySignal,
	NOTE_TIER2_MAX_CHARS,
	NOTE_TIER3_MAX_CHARS,
	parseTierMarker,
} from "../src/core/memory/degrade.ts";
import {
	MemoryStore,
	projectMemoryDir,
	projectMemoryFile,
	projectSessionsDir,
} from "../src/core/memory/memory-store.ts";

/**
 * Three-tier structural degradation of session notes: age-triggered rewrites (tier 2 truncation,
 * tier 3 key-signal extraction), idempotency, and the search-side tier downweight. Note age is
 * always derived from the file-name date prefix.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): { store: MemoryStore; root: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-degrade-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	return { store: new MemoryStore(root), root, cwd };
}

function dateDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function writeNote(root: string, cwd: string, name: string, content: string, processed = false): string {
	const sessionsDir = projectSessionsDir(root, cwd);
	mkdirSync(sessionsDir, { recursive: true });
	const path = join(sessionsDir, name);
	if (processed) {
		const hash = createHash("sha256").update(content).digest("hex");
		const metadata = { id: name, sessionId: name, compactionId: name, contentHash: hash, storedHash: hash };
		writeFileSync(path, `<!-- memory-note:${JSON.stringify(metadata)} -->\n${content}`, "utf8");
		writeFileSync(
			join(projectMemoryDir(root, cwd), ".dream-state.json"),
			JSON.stringify({ lastConsolidatedAt: Date.now(), processed: { [name]: hash } }),
		);
	} else writeFileSync(path, content, "utf8");
	return path;
}

describe("degradeSessionNotes", () => {
	it("truncates a 100-day-old note to tier 2 with a first-line marker", () => {
		const { store, root, cwd } = createStore();
		const long = `alpha ${"filler content ".repeat(100)}`;
		const path = writeNote(root, cwd, `${dateDaysAgo(100)}-note-00000001.md`, long, true);
		expect(store.degradeSessionNotes(cwd)).toEqual({ degraded: 1 });
		const rewritten = readFileSync(path, "utf-8");
		const { tier, body } = parseTierMarker(rewritten.slice(rewritten.indexOf("\n") + 1));
		expect(tier).toBe(2);
		expect(body.length).toBeLessThanOrEqual(NOTE_TIER2_MAX_CHARS);
		expect(rewritten.includes("\n<!-- memory-tier:2 degraded:")).toBe(true);
	});

	it("reduces a 200-day-old note to tier 3 key signal (headings and list lines)", () => {
		const { store, root, cwd } = createStore();
		const content = [
			"# Debugging the flaky pipeline",
			"",
			`Long prose paragraph that should not survive tier 3. ${"more words ".repeat(50)}`,
			"- root cause: stale cache key",
			"- fix: bump CACHE_VERSION",
			"",
			"Another throwaway paragraph.",
		].join("\n");
		const path = writeNote(root, cwd, `${dateDaysAgo(200)}-note-00000002.md`, content, true);
		expect(store.degradeSessionNotes(cwd)).toEqual({ degraded: 1 });
		const { tier, body } = parseTierMarker(readFileSync(path, "utf-8").split("\n").slice(1).join("\n"));
		expect(tier).toBe(3);
		expect(body.length).toBeLessThanOrEqual(NOTE_TIER3_MAX_CHARS);
		expect(body).toContain("# Debugging the flaky pipeline");
		expect(body).toContain("- root cause: stale cache key");
		expect(body).not.toContain("throwaway");
	});

	it("is idempotent and never lowers a tier", () => {
		const { store, root, cwd } = createStore();
		const path = writeNote(root, cwd, `${dateDaysAgo(100)}-note-00000003.md`, "alpha ".repeat(300), true);
		expect(store.degradeSessionNotes(cwd)).toEqual({ degraded: 1 });
		const afterFirst = readFileSync(path, "utf-8");
		expect(store.degradeSessionNotes(cwd)).toEqual({ degraded: 0 });
		expect(readFileSync(path, "utf-8")).toBe(afterFirst);

		// A hand-marked tier 3 note only 100 days old (target tier 2) must not be downgraded.
		const marked = writeNote(
			root,
			cwd,
			`${dateDaysAgo(100)}-note-00000004.md`,
			"<!-- memory-tier:3 degraded:2026-01-01T00:00:00.000Z -->\n- already compressed",
		);
		expect(store.degradeSessionNotes(cwd)).toEqual({ degraded: 0 });
		expect(parseTierMarker(readFileSync(marked, "utf-8")).tier).toBe(3);
	});

	it("leaves fresh notes untouched", () => {
		const { store, root, cwd } = createStore();
		const content = "brand new note content";
		const path = writeNote(root, cwd, `${dateDaysAgo(0)}-note-00000005.md`, content);
		expect(store.degradeSessionNotes(cwd)).toEqual({ degraded: 0 });
		expect(readFileSync(path, "utf-8")).toBe(content);
	});

	it("never rewrites curated MEMORY.md", () => {
		const { store, root, cwd } = createStore();
		mkdirSync(projectMemoryDir(root, cwd), { recursive: true });
		const curated = `\n<!-- id:mem-cur00001 -->\n## Project memory — 2020-01-01T00:00:00.000Z\n\nvery old curated fact ${"x".repeat(1000)}\n`;
		writeFileSync(projectMemoryFile(root, cwd), curated, "utf-8");
		writeNote(root, cwd, `${dateDaysAgo(200)}-note-00000006.md`, "old note");
		store.degradeSessionNotes(cwd);
		expect(readFileSync(projectMemoryFile(root, cwd), "utf-8")).toBe(curated);
	});
});

describe("search tier downweight", () => {
	it("ranks a tier 1 note above an identical tier 3 note of the same age", async () => {
		const { store, root, cwd } = createStore();
		const today = dateDaysAgo(0);
		writeNote(root, cwd, `${today}-note-tier1aaa.md`, "epsilon shared fact");
		writeNote(
			root,
			cwd,
			`${today}-note-tier3bbb.md`,
			"<!-- memory-tier:3 degraded:2026-01-01T00:00:00.000Z -->\nepsilon shared fact",
		);
		const hits = await store.search("epsilon", "project", cwd);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.path).toContain("tier1aaa");
		// Same term score, same age: only the tier weight separates them.
		expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
	});
});

describe("degradeNoteContent", () => {
	it("targets the tier for the age and skips rewrites below the first boundary", () => {
		const now = new Date();
		expect(degradeNoteContent("young note", 15, now)).toBeUndefined();
		expect(degradeNoteContent("old note", 30, now)).toContain("memory-tier:2");
		expect(degradeNoteContent("ancient note", 180, now)).toContain("memory-tier:3");
	});

	it("upgrades an existing tier 2 note to tier 3 once past the second boundary", () => {
		const tier2 = degradeNoteContent(`- keep this line\n${"prose ".repeat(300)}`, 40, new Date())!;
		const tier3 = degradeNoteContent(tier2, 200, new Date())!;
		const parsed = parseTierMarker(tier3);
		expect(parsed.tier).toBe(3);
		expect(parsed.body).toContain("- keep this line");
	});
});

describe("extractKeySignal", () => {
	it("keeps heading and list lines in order", () => {
		const text = "# Title\nprose to drop\n- first\nmore prose\n1. second\n* third";
		expect(extractKeySignal(text, 200)).toBe("# Title\n- first\n1. second\n* third");
	});

	it("falls back to a prefix cut with ellipsis for unstructured text", () => {
		const text = "plain sentence without any structure repeated ".repeat(20);
		const result = extractKeySignal(text, 100);
		expect(result.length).toBeLessThanOrEqual(100);
		expect(result.endsWith("…")).toBe(true);
	});

	it("stops collecting structured lines at the budget", () => {
		const text = `- ${"a".repeat(80)}\n- ${"b".repeat(80)}\n- ${"c".repeat(80)}`;
		const result = extractKeySignal(text, 170);
		expect(result).toContain("a".repeat(80));
		expect(result).toContain("b".repeat(80));
		expect(result).not.toContain("c".repeat(80));
	});
});
