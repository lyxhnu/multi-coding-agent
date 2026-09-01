import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxManager } from "../src/core/sandbox/sandbox-manager.ts";
import { resolveSandboxSettings } from "../src/core/sandbox/types.ts";
import { createBashTool } from "../src/core/tools/bash.ts";

describe("bash tool sandbox wiring (M7, opt-in)", () => {
	it("without a sandbox option, behavior is unchanged (default for every existing caller)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-off-"));
		try {
			const tool = createBashTool(tempDir);
			const result = await tool.execute("call-1", { command: "echo unwrapped" });
			expect(result.content.some((part: any) => part.type === "text" && part.text.includes("unwrapped"))).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("runs the command unwrapped when the sandbox best-effort-falls-back on an unsupported platform", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-fallback-"));
		try {
			const manager = new SandboxManager({ workspaceRoot: tempDir, platform: "win32" });
			const tool = createBashTool(tempDir, {
				sandbox: { manager, settings: resolveSandboxSettings({ profile: "workspace" }) },
			});
			const result = await tool.execute("call-2", { command: "echo still-runs" });
			expect(result.content.some((part: any) => part.type === "text" && part.text.includes("still-runs"))).toBe(
				true,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed (never executes) for a strict profile on an unsupported platform", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-failclosed-"));
		try {
			const manager = new SandboxManager({ workspaceRoot: tempDir, platform: "win32" });
			const tool = createBashTool(tempDir, {
				sandbox: { manager, settings: resolveSandboxSettings({ profile: "strict" }) },
			});
			const markerPath = join(tempDir, "marker.txt");
			await expect(tool.execute("call-3", { command: `touch ${markerPath}` })).rejects.toThrow(/Sandbox denied/);
			expect(() => statSync(markerPath)).toThrow();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('calls onSandboxOff exactly when the resolved profile is "off" (spec 12: audit requirement)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-audit-"));
		try {
			const manager = new SandboxManager({ workspaceRoot: tempDir, platform: "win32" });
			const audited: string[] = [];
			const tool = createBashTool(tempDir, {
				sandbox: {
					manager,
					settings: resolveSandboxSettings({ profile: "off" }),
					onSandboxOff: (redactedCommand) => audited.push(redactedCommand),
				},
			});
			await tool.execute("call-4", { command: "echo audited-run" });
			expect(audited).toEqual(["echo audited-run"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
