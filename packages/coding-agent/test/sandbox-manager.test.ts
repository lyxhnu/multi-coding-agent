import { describe, expect, it } from "vitest";
import { SandboxManager } from "../src/core/sandbox/sandbox-manager.ts";
import { DEFAULT_SANDBOX_SETTINGS, resolveSandboxSettings } from "../src/core/sandbox/types.ts";

describe("SandboxManager (M7)", () => {
	it("resolveSandboxSettings applies the Grok-aligned defaults (profile=workspace, mode=best-effort, childNetwork=unrestricted)", () => {
		expect(resolveSandboxSettings(undefined)).toEqual(DEFAULT_SANDBOX_SETTINGS);
	});

	it("wraps the command through sandbox-exec on darwin, with a workspace-scoped write allow", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "darwin" });
		const result = manager.build("bash", ["-c", "echo hi"], resolveSandboxSettings({ profile: "workspace" }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.wrapped.command).toBe("sandbox-exec");
			expect(result.wrapped.args[0]).toBe("-p");
			expect(result.wrapped.args as string[]).toEqual(expect.arrayContaining(["--", "bash", "-c", "echo hi"]));
			expect(result.wrapped.args[1]).toContain('(allow file-write* (subpath "/repo"))');
			expect(result.wrapped.args[1]).toContain("(allow network*)"); // unrestricted by default
		}
	});

	it("read-only and strict profiles never allow file-write* in the generated macOS profile", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "darwin" });
		for (const profile of ["read-only", "strict"] as const) {
			const result = manager.build("bash", ["-c", "echo hi"], resolveSandboxSettings({ profile }));
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.wrapped.args[1]).not.toContain("file-write*");
			}
		}
	});

	it("childNetwork=blocked omits the network allow rule (deny default takes over)", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "darwin" });
		const result = manager.build(
			"bash",
			[],
			resolveSandboxSettings({ profile: "workspace", childNetwork: "blocked" }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.wrapped.args[1]).not.toContain("(allow network*)");
	});

	it("wraps the command through bwrap on linux, read-only-binding the workspace for read-only/strict, and unsharing net when blocked", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "linux" });
		const result = manager.build(
			"bash",
			["-c", "echo hi"],
			resolveSandboxSettings({ profile: "strict", childNetwork: "blocked" }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.wrapped.command).toBe("bwrap");
			expect(result.wrapped.args).toEqual(expect.arrayContaining(["--ro-bind", "/repo", "/repo", "--unshare-net"]));
		}
	});

	it("fails closed for read-only/strict on a platform with no sandbox backend, even in best-effort mode", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "win32" });
		const result = manager.build("bash", [], resolveSandboxSettings({ profile: "strict", mode: "best-effort" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("fail");
			expect(result.reason).toContain("win32");
		}
	});

	it("falls back to running unsandboxed for workspace/devbox in best-effort mode on an unsupported platform", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "win32" });
		const result = manager.build("bash", ["-c", "echo hi"], resolveSandboxSettings({ profile: "workspace" }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.wrapped).toEqual({ command: "bash", args: ["-c", "echo hi"] });
	});

	it("mode=required fails closed on an unsupported platform even for the permissive workspace profile", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "win32" });
		const result = manager.build("bash", [], resolveSandboxSettings({ profile: "workspace", mode: "required" }));
		expect(result.ok).toBe(false);
	});

	it('profile="off" is a pass-through but always flags auditRequired (spec 12: "off 必须审计")', () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "darwin" });
		const result = manager.build("bash", ["-c", "rm -rf /tmp/x"], resolveSandboxSettings({ profile: "off" }));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.wrapped).toEqual({ command: "bash", args: ["-c", "rm -rf /tmp/x"] });
			expect(result.auditRequired).toBe(true);
		}
	});

	it("a custom profile is passed through verbatim to sandbox-exec on darwin", () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "darwin" });
		const result = manager.build(
			"bash",
			[],
			resolveSandboxSettings({ profile: { custom: "(version 1)\n(allow default)" } }),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.wrapped.command).toBe("sandbox-exec");
			expect(result.wrapped.args).toEqual(["-p", "(version 1)\n(allow default)", "--", "bash"]);
		}
	});
});
