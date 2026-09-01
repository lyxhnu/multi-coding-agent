import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("Plan Mode", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});
	const planTools = ["read", "bash", "edit", "write", "enter_plan_mode", "exit_plan_mode"];

	it("enter_plan_mode narrows the active tool set to read-only tools", async () => {
		const harness = await createHarness({ initialActiveToolNames: planTools });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("planning now"),
		]);
		await harness.session.prompt("plan this out");
		expect(harness.session.getActiveToolNames().sort()).toEqual(
			[
				"enter_plan_mode",
				"exit_plan_mode",
				"find",
				"get_task_output",
				"grep",
				"history_get",
				"ls",
				"read",
				"todo_write",
			].sort(),
		);
		expect(harness.session.getActiveToolNames()).not.toContain("edit");
		expect(harness.session.getActiveToolNames()).not.toContain("bash");
	});

	it("exit_plan_mode fails closed (no approval channel) and keeps plan mode active", async () => {
		// A tiny approval timeout stands in for "no driver (TUI/RPC) is connected to resolve the
		// PendingInteraction": production defaults to 120s (see settings-manager.ts), but nothing in
		// this test ever calls resolvePendingInteraction, so it must fail closed via timeout.
		const harness = await createHarness({
			initialActiveToolNames: planTools,
			settings: { planMode: { approvalTimeoutMs: 20 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("planning now"),
		]);
		await harness.session.prompt("plan this out");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("exit_plan_mode", { title: "T", objective: "O", steps: ["1"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("still planning"),
		]);
		await harness.session.prompt("go ahead");

		const toolResult = harness.session.messages.filter((m) => m.role === "toolResult").pop();
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(getMessageText(toolResult)).toContain("not approved");
		}
		expect(harness.session.getActiveToolNames()).not.toContain("edit");
	});

	it("approving the pending plan interaction restores the previous tool set", async () => {
		const harness = await createHarness({ initialActiveToolNames: planTools });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("planning now"),
		]);
		const beforePlanTools = harness.session.getActiveToolNames();
		await harness.session.prompt("plan this out");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("exit_plan_mode", { title: "T", objective: "O", steps: ["1", "2"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("executing"),
		]);
		const promptPromise = harness.session.prompt("go ahead");
		// Approve as soon as the interaction is registered.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const pending = (
			harness.session as unknown as { _pendingInteractions: { list(): { toolCallId: string }[] } }
		)._pendingInteractions.list();
		expect(pending).toHaveLength(1);
		harness.session.resolvePendingInteraction(pending[0]!.toolCallId, { approved: true });
		await promptPromise;

		expect(harness.session.getPlanModeState().status).toBe("off");
		expect(harness.session.getActiveToolNames().sort()).toEqual([...beforePlanTools].sort());
	});

	it("Plan Mode survives session resume/reload: it is persisted to a session custom entry (spec 7), not just held in memory", async () => {
		const harness = await createHarness({ initialActiveToolNames: planTools });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("planning now"),
		]);
		await harness.session.prompt("plan this out");
		expect(harness.session.getPlanModeState().status).toBe("planning");

		// Simulate resuming this exact session in a fresh process: a brand-new AgentSession built on top
		// of the *same* SessionManager (which by now has a "plan-mode-state" custom entry from
		// enter_plan_mode above) must restore the narrowed, read-only tool set on construction — a stale
		// resumed session must not silently regain write tools mid-plan.
		const resumedAgent = new Agent({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: { model: harness.getModel(), systemPrompt: "resumed", tools: [] },
			convertToLlm,
		});
		const resumed = new AgentSession({
			agent: resumedAgent,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: createTestResourceLoader(),
			memoryRootDir: harness.session.memoryStore.rootDir,
		});
		try {
			expect(resumed.getPlanModeState().status).toBe("planning");
			expect(resumed.getActiveToolNames()).not.toContain("edit");
			expect(resumed.getActiveToolNames()).not.toContain("bash");
			expect(resumed.getActiveToolNames()).toContain("exit_plan_mode");
		} finally {
			await resumed.dispose();
		}
	});
});

describe("TodoGate", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("does not fire by default (disabled)", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["todo_write"] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "a", status: "pending" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done for now"),
		]);
		await harness.session.prompt("start work");
		expect(harness.session.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("forces a follow-up turn when enabled and pending todos remain", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["todo_write"],
			settings: { reminder: { todoGate: { enabled: true } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "a", status: "pending" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("first turn done"),
			fauxAssistantMessage("second turn done"),
		]);
		await harness.session.prompt("start work");
		await harness.session.agent.waitForIdle();

		const assistantTexts = harness.session.messages
			.filter((m) => m.role === "assistant")
			.map((m) => getMessageText(m));
		expect(assistantTexts).toContain("second turn done");
	});

	it("does not fire when the reminder master switch is disabled", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["todo_write"],
			settings: { reminder: { enabled: false, todoGate: { enabled: true } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "a", status: "pending" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("start work");
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
	});
});
