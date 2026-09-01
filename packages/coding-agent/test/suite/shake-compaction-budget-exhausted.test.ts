import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type SessionInternals = {
	_midPromptCompactions: number;
	_lastLimitedInput?: number;
	_handlePostAgentRun: () => Promise<boolean>;
	_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
};

describe("shake when the mid-prompt compaction budget is exhausted", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) await h.cleanup();
	});
	async function seed(resultTokens = 120000) {
		const h = await createHarness({ settings: { compaction: { enabled: true } } });
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		h.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "bash",
			toolCallId: "saved",
			content: [{ type: "text", text: "x".repeat(resultTokens * 4) }],
			isError: false,
			timestamp: 2,
		});
		h.sessionManager.appendMessage({ role: "user", content: "tail", timestamp: 3 });
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		return { h, internals: h.session as unknown as SessionInternals };
	}
	it("requests a rescue after the third compaction without another summary call", async () => {
		const { h, internals } = await seed();
		internals._midPromptCompactions = 3;
		await h.session.agent.continue();
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
		await expect(internals._handlePostAgentRun()).resolves.toBe(true);
		expect(h.eventsOfType("shake")[0]?.reason).toBe("compaction-budget-exhausted");
		expect(internals._midPromptCompactions).toBe(3);
		expect(h.faux.state.callCount).toBe(0);
	});
	it("uses compaction while the bounded allowance remains", async () => {
		const { h, internals } = await seed();
		const summary = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(false);
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		expect(summary).toHaveBeenCalledWith("threshold", true);
		expect(internals._midPromptCompactions).toBe(1);
	});
	it("leaves a comfortable context alone", async () => {
		const { h, internals } = await seed(1000);
		internals._midPromptCompactions = 3;
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.agent.continue();
		await expect(internals._handlePostAgentRun()).resolves.toBe(false);
		expect(h.eventsOfType("shake")).toHaveLength(0);
		expect(internals._midPromptCompactions).toBe(3);
	});
	it("rebuilds context and continues without replaying original tools", async () => {
		const { h, internals } = await seed();
		internals._midPromptCompactions = 3;
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		const result = h.session.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(result).length).toBeLessThan(1000);
		expect(JSON.stringify(result)).toContain("history_get");
		h.setResponses([fauxAssistantMessage("recovered")]);
		await h.session.agent.continue();
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("tool_execution_start")).toHaveLength(0);
	});
	it("stops clearly when exhausted and no shake source is available", async () => {
		const { h, internals } = await seed(100);
		h.sessionManager.appendMessage({ role: "user", content: "plain ".repeat(80000), timestamp: 4 });
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		internals._midPromptCompactions = 3;
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		await expect(internals._handlePostAgentRun()).resolves.toBe(false);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});
	it("does not resubmit an unchanged limited request", async () => {
		const { h, internals } = await seed();
		vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(false);
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		await expect(internals._handlePostAgentRun()).resolves.toBe(false);
		expect(internals._midPromptCompactions).toBe(1);
		expect(h.faux.state.callCount).toBe(0);
	});
	it("resets the allowance and previous limit when a new prompt starts", async () => {
		const { h, internals } = await seed(1000);
		internals._midPromptCompactions = 3;
		internals._lastLimitedInput = 120000;
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("hello");
		expect(internals._midPromptCompactions).toBe(0);
		expect(internals._lastLimitedInput).toBeUndefined();
	});
});
