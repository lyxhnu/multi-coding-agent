import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalMemoryFile, MemoryStore, projectMemoryFile } from "../src/core/memory/memory-store.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MemoryStore paths", () => {
	it("creates global and project memory in their exact parent directories", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-memory-paths-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const store = new MemoryStore(join(root, "memory"));

		store.appendGlobal(["global fact"]);
		store.appendProject(cwd, ["project fact"]);

		const globalFile = globalMemoryFile(store.rootDir);
		const projectFile = projectMemoryFile(store.rootDir, cwd);
		expect(existsSync(globalFile)).toBe(true);
		expect(existsSync(projectFile)).toBe(true);
		expect(existsSync(dirname(globalFile))).toBe(true);
		expect(existsSync(dirname(projectFile))).toBe(true);
	});
});
