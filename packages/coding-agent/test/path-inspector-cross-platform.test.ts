import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPath, isPathWithinScope, isWithinScope } from "../src/core/permissions/path-inspector.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-path-inspector-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	return workspace;
}

describe("path inspector containment", () => {
	it("accepts existing and not-yet-created descendants", () => {
		const workspace = createWorkspace();
		writeFileSync(join(workspace, "existing.ts"), "export {};", "utf-8");

		expect(isPathWithinScope("existing.ts", workspace, workspace)).toBe(true);
		expect(isPathWithinScope(join("src", "nested", "new.ts"), workspace, workspace)).toBe(true);
		expect(inspectPath(join("src", "nested", "new.ts"), workspace).canonicalPath).toBe(
			join(workspace, "src", "nested", "new.ts"),
		);
	});

	it("rejects traversal and sibling-prefix paths", () => {
		const workspace = createWorkspace();
		const sibling = `${workspace}-evil`;
		mkdirSync(sibling);

		expect(isPathWithinScope(join("..", "outside.ts"), workspace, workspace)).toBe(false);
		expect(isWithinScope(join(sibling, "file.ts"), workspace)).toBe(false);
	});

	it("rejects an existing symlink that escapes the workspace", () => {
		const workspace = createWorkspace();
		const outside = join(workspace, "..", "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
		const link = join(workspace, "escape");
		symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

		expect(isPathWithinScope(join("escape", "secret.txt"), workspace, workspace)).toBe(false);
	});
});
