import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../../../src/core/tools/bash.ts";

const ctx = {} as ExtensionContext;

function instantOps(): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from("ok\n"));
			return { exitCode: 0 };
		},
	};
}

/** Spec 4.1/15.1: bash `timeout` is milliseconds by default (Grok-aligned); `legacyTimeoutSeconds` keeps the old seconds unit during the migration window. */
describe("bash timeout unit migration (spec 4.1/15.1)", () => {
	it("interprets timeout as milliseconds by default", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: instantOps(),
			exposeSessionEnvironment: false,
		});
		// 50ms is enough for the instant fake op to finish either way; this just proves no early rejection.
		const result = await definition.execute("call-1", { command: "echo ok", timeout: 50 }, undefined, undefined, ctx);
		expect((result.content[0] as { text: string }).text).toContain("ok");
	});

	it("warns (without failing) when timeout looks like a leftover seconds value", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: instantOps(),
			exposeSessionEnvironment: false,
		});
		const result = await definition.execute("call-2", { command: "echo ok", timeout: 30 }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("timeout unit notice");
		expect(text).toContain("timeout: 30000");
	});

	it("does not warn once timeout is a realistic millisecond value", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: instantOps(),
			exposeSessionEnvironment: false,
		});
		const result = await definition.execute(
			"call-3",
			{ command: "echo ok", timeout: 30_000 },
			undefined,
			undefined,
			ctx,
		);
		expect((result.content[0] as { text: string }).text).not.toContain("timeout unit notice");
	});

	it("legacyTimeoutSeconds=true restores the original seconds-based unit and suppresses the warning", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: instantOps(),
			exposeSessionEnvironment: false,
			legacyTimeoutSeconds: true,
		});
		const result = await definition.execute("call-4", { command: "echo ok", timeout: 30 }, undefined, undefined, ctx);
		expect((result.content[0] as { text: string }).text).not.toContain("timeout unit notice");
	});

	it("a real timeout under the new millisecond unit actually fires quickly (using the real local exec backend)", async () => {
		// No `operations` override here: exercises createLocalBashOperations()'s real setTimeout-based
		// timeout/kill logic, not a fake — so this proves the ms conversion reaches the actual process kill path.
		const definition = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false });
		const start = Date.now();
		await expect(
			definition.execute("call-5", { command: "sleep 5", timeout: 50 }, undefined, undefined, ctx),
		).rejects.toThrow(/timed out/i);
		expect(Date.now() - start).toBeLessThan(3000);
	});
});
