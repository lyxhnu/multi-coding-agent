import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxManager } from "../../../src/core/sandbox/sandbox-manager.ts";
import { resolveSandboxSettings } from "../../../src/core/sandbox/types.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Spec 12: sandbox profiles (workspace/devbox/read-only/strict/off/custom). Hard gate: "sandbox required
 * 缺失仍执行" (a `mode: "required"` sandbox must never silently execute unsandboxed) must stay at 0.
 * See sandbox-manager.test.ts / sandbox-bash-wiring.test.ts (test/) for the exhaustive per-platform
 * profile-generation coverage; this file is the grok-alignment-named entry point plus the settings surface.
 */
describe("sandbox profile (M9 eval: sandbox-profile)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it('settingsManager.getSandboxSettings() defaults to profile="workspace", mode="best-effort"', async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.settingsManager.getSandboxSettings()).toEqual({
			profile: "workspace",
			mode: "best-effort",
			childNetwork: "unrestricted",
		});
	});

	it("settings round-trip: an explicit sandbox profile/mode/childNetwork is preserved", async () => {
		const harness = await createHarness({
			settings: { sandbox: { profile: "strict", mode: "required", childNetwork: "blocked" } },
		});
		harnesses.push(harness);
		expect(harness.settingsManager.getSandboxSettings()).toEqual({
			profile: "strict",
			mode: "required",
			childNetwork: "blocked",
		});
	});

	it('hard gate: mode="required" never falls back to running unsandboxed on a platform without a backend', () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "win32" });
		for (const profile of ["workspace", "devbox", "read-only", "strict"] as const) {
			const result = manager.build("bash", [], resolveSandboxSettings({ profile, mode: "required" }));
			expect(result.ok).toBe(false);
		}
	});

	it("read-only and strict profiles deny every write, on every implemented backend (macOS + Linux)", () => {
		for (const platform of ["darwin", "linux"] as const) {
			const manager = new SandboxManager({ workspaceRoot: "/repo", platform });
			for (const profile of ["read-only", "strict"] as const) {
				const result = manager.build("bash", [], resolveSandboxSettings({ profile }));
				expect(result.ok).toBe(true);
				if (result.ok) {
					const rendered = JSON.stringify(result.wrapped);
					expect(rendered.includes("file-write*") || rendered.includes("--bind")).toBe(false);
				}
			}
		}
	});

	it('hard gate: profile="off" always requires an audit record', () => {
		const manager = new SandboxManager({ workspaceRoot: "/repo", platform: "darwin" });
		const result = manager.build("bash", ["-c", "anything"], resolveSandboxSettings({ profile: "off" }));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.auditRequired).toBe(true);
	});

	const sandboxed = process.platform === "darwin" || process.platform === "linux";
	const itSandboxed = sandboxed ? it : it.skip;

	itSandboxed(
		"an explicitly configured settings.sandbox is honored by the *root* session's own bash tool, not just by subagents",
		async () => {
			const harness = await createHarness({
				settings: { sandbox: { profile: "strict" }, permissions: { mode: "bypassPermissions" } },
			});
			harnesses.push(harness);
			const markerPath = join(harness.tempDir, "root-session-strict-marker.txt");

			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${markerPath}` }), { stopReason: "toolUse" }),
				fauxAssistantMessage("could not write: sandboxed"),
			]);
			await harness.session.prompt("touch a file");

			// The OS-level sandbox (sandbox-exec/bwrap) denies the write at the kernel level: the wrapped
			// `touch` command runs and exits non-zero rather than the tool call itself throwing (see
			// sandbox-manager.test.ts's "strict... deny every write" case) — so the file never existing is
			// the authoritative signal here, matching the equivalent subagent-level assertion in
			// subagent-sandbox-binding.test.ts.
			expect(existsSync(markerPath)).toBe(false);
		},
		20_000,
	);

	it("without any explicit settings.sandbox, the root session's bash tool stays unsandboxed (unchanged default)", async () => {
		const harness = await createHarness({ settings: { permissions: { mode: "bypassPermissions" } } });
		harnesses.push(harness);
		const markerPath = join(harness.tempDir, "root-session-default-marker.txt");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${markerPath}` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("wrote it"),
		]);
		await harness.session.prompt("touch a file");

		expect(existsSync(markerPath)).toBe(true);
	});
});
