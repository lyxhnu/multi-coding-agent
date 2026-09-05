import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ContextMaintenanceAction,
	ContextMaintenanceBudget,
	ContextMaintenanceSnapshot,
	ReductionAttemptResult,
} from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionInternals = {
	_contextMaintenanceBudget: ContextMaintenanceBudget;
	_handlePostAgentRun: () => Promise<ContextMaintenanceAction>;
	_runSoftCompaction: (
		cause: "budget_limit" | "provider_overflow" | "threshold",
		willRetry: boolean,
		snapshot: ContextMaintenanceSnapshot,
		attemptIndex: number,
	) => Promise<ReductionAttemptResult>;
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
		internals._contextMaintenanceBudget.softCompactionOperationsStarted = 3;
		await h.session.agent.continue();
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
		await expect(internals._handlePostAgentRun()).resolves.toBe("continue");
		expect(h.eventsOfType("shake")[0]?.reason).toBe("compaction-budget-exhausted");
		expect(internals._contextMaintenanceBudget.softCompactionOperationsStarted).toBe(3);
		expect(h.faux.state.callCount).toBe(0);
	});
	it("uses compaction while the bounded allowance remains", async () => {
		const { h, internals } = await seed();
		const summary = vi
			.spyOn(internals, "_runSoftCompaction")
			.mockImplementation(async (_cause, _retry, value, index) => ({
				outcome: "failed",
				method: "soft_compaction",
				attemptIndex: index,
				requestFingerprint: value.fingerprint,
				tokensBefore: value.budget.tokens,
				reason: "provider_failed",
			}));
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		expect(summary).toHaveBeenCalledWith("budget_limit", true, expect.any(Object), expect.any(Number));
		expect(internals._contextMaintenanceBudget.softCompactionOperationsStarted).toBe(1);
	});
	it("leaves a comfortable context alone", async () => {
		const { h, internals } = await seed(1000);
		internals._contextMaintenanceBudget.softCompactionOperationsStarted = 3;
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.agent.continue();
		await expect(internals._handlePostAgentRun()).resolves.toBe("wait");
		expect(h.eventsOfType("shake")).toHaveLength(0);
		expect(internals._contextMaintenanceBudget.softCompactionOperationsStarted).toBe(3);
	});
	it("rebuilds context and continues without replaying original tools", async () => {
		const { h, internals } = await seed();
		internals._contextMaintenanceBudget.softCompactionOperationsStarted = 3;
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
		internals._contextMaintenanceBudget.softCompactionOperationsStarted = 3;
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		await expect(internals._handlePostAgentRun()).resolves.toBe("stop");
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
	});
	it("does not resubmit an unchanged limited request", async () => {
		const { h, internals } = await seed();
		vi.spyOn(internals, "_runSoftCompaction").mockImplementation(async (_cause, _retry, value, index) => ({
			outcome: "failed",
			method: "soft_compaction",
			attemptIndex: index,
			requestFingerprint: value.fingerprint,
			tokensBefore: value.budget.tokens,
			reason: "provider_failed",
		}));
		await h.session.agent.continue();
		await internals._handlePostAgentRun();
		await expect(internals._handlePostAgentRun()).resolves.toBe("stop");
		expect(internals._contextMaintenanceBudget.softCompactionOperationsStarted).toBe(1);
		expect(h.faux.state.callCount).toBe(0);
	});
	it("resets the allowance and previous limit when a new prompt starts", async () => {
		const { h, internals } = await seed(1000);
		const generation = internals._contextMaintenanceBudget.promptGeneration;
		internals._contextMaintenanceBudget.softCompactionOperationsStarted = 3;
		internals._contextMaintenanceBudget.rejectedRequestFingerprints.add("limited-request");
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("hello");
		expect(internals._contextMaintenanceBudget.promptGeneration).toBe(generation + 1);
		expect(internals._contextMaintenanceBudget.softCompactionOperationsStarted).toBe(0);
		expect(internals._contextMaintenanceBudget.rejectedRequestFingerprints.size).toBe(0);
	});
});
