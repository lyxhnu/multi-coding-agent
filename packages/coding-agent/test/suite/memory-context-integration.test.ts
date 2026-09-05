import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { RESCUE_SHAKE_CONFIG } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact } from "../../src/core/compaction/compaction.ts";
import type {
	ContextMaintenanceSnapshot,
	ReductionAttemptResult,
} from "../../src/core/compaction/context-maintenance.ts";
import { projectSessionsDir } from "../../src/core/memory/memory-store.ts";
import { createHistoryGetToolDefinition } from "../../src/core/tools/history-get.ts";
import { createHarness, type Harness } from "./harness.ts";

type CompactionInternals = {
	_contextMaintenanceSnapshot: () => Promise<ContextMaintenanceSnapshot>;
	_runSoftCompaction: (
		cause: "threshold",
		willRetry: boolean,
		snapshot: ContextMaintenanceSnapshot,
		attemptIndex: number,
	) => Promise<ReductionAttemptResult>;
};

async function compactOnce(internals: CompactionInternals): Promise<ReductionAttemptResult> {
	return await internals._runSoftCompaction("threshold", false, await internals._contextMaintenanceSnapshot(), 1);
}

describe("memory-context-integrity: cross-module boundaries", () => {
	it("E01/E03/K03/K04 preserves constraints through tools, shake, incremental compaction and disk restart", async () => {
		let filePath = "";
		let executions = 0;
		const reader: AgentTool = {
			name: "read",
			label: "read",
			description: "read fixture",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: readFileSync(filePath, "utf8") }], details: {} };
			},
		};
		const h = await createHarness({
			persistSession: true,
			tools: [reader],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 2048, twoPassEnabled: true } },
		});
		harnesses.push(h);
		filePath = `${h.tempDir}/source.txt`;
		writeFileSync(filePath, "ORIGINAL SNAPSHOT\n".repeat(1600));
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("pending work"),
		]);
		await h.session.prompt("Constraint: never publish without approval.");
		expect(executions).toBe(1);
		const source = h.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
		await h.session.shake(RESCUE_SHAKE_CONFIG, "manual");
		writeFileSync(filePath, "CHANGED FILE");
		const history = await createHistoryGetToolDefinition(h.sessionManager).execute(
			"history",
			{ entryId: source.id, limit: 17 },
			undefined,
			undefined,
			h.session.extensionRunner.createContext(),
		);
		expect(JSON.stringify(history.content)).toContain("ORIGINAL SNAPSHOT");
		expect(executions).toBe(1);
		h.session.setActiveToolsByName(["read", "history_get"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("history_get", { entryId: source.id, limit: 17 }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("ORIGINAL SNAPSHOT");
				expect(JSON.stringify(context.messages)).not.toContain("CHANGED FILE");
				return fauxAssistantMessage("saved history reviewed");
			},
		]);
		await h.session.prompt("Read the saved history, then continue the review.");
		expect(h.eventsOfType("tool_execution_end").find((event) => event.toolName === "history_get")?.isError).toBe(
			false,
		);
		expect(executions).toBe(1);
		h.setResponses([
			(context) => {
				const requestText = context.messages
					.flatMap((message) =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
					)
					.join("\n");
				const payload = JSON.parse(requestText.split("\n\n").at(-1)!) as {
					sourceEntries: Array<{
						id: string;
						type: string;
						message?: { role: string; content: string | Array<{ type: string; text?: string }> };
					}>;
				};
				const users = payload.sourceEntries.filter(
					(entry) => entry.type === "message" && entry.message?.role === "user",
				);
				const objective = users.at(-1);
				const constraint = users.find((entry) => JSON.stringify(entry.message?.content).includes("never publish"));
				if (!objective?.message || !constraint) throw new Error("missing checkpoint sources");
				const objectiveText =
					typeof objective.message.content === "string"
						? objective.message.content
						: objective.message.content.map((part) => part.text ?? "").join("\n");
				return fauxAssistantMessage(
					JSON.stringify({
						checkpoint: {
							version: 1,
							objective: { text: objectiveText, sourceEntryIds: [objective.id] },
							userConstraints: [
								{
									text: "never publish without approval.",
									sourceEntryIds: [constraint.id],
								},
							],
							acceptanceCriteria: { status: "not_specified", items: [] },
							decisions: [],
							completedWork: [],
							currentState: {
								text: "Saved history reviewed; approval required.",
								evidenceEntryIds: [objective.id],
							},
							failedAttempts: [],
							nextAction: { text: "Continue the review.", evidenceEntryIds: [] },
							historyRefs: [],
						},
						noteUpdateCandidates: [],
					}),
				);
			},
		]);
		const internals = h.session as unknown as CompactionInternals & {
			_maybeStartTwoPassPrefire(): void;
		};
		internals._maybeStartTwoPassPrefire();
		await vi.waitFor(() =>
			expect(
				h.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "context-rollover-checkpoint"),
			).toBe(true),
		);
		h.setResponses([fauxAssistantMessage("tail progress")]);
		await h.session.prompt("Process the next step");
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("never publish without approval");
				expect(JSON.stringify(context)).not.toContain("ORIGINAL SNAPSHOT");
				return fauxAssistantMessage("Constraint: never publish without approval. Next: review changes.");
			},
			(context) => {
				expect(JSON.stringify(context)).not.toContain("ORIGINAL SNAPSHOT");
				return fauxAssistantMessage("Next: review changes; approval required.");
			},
		]);
		await compactOnce(internals);
		expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({
			aborted: false,
			result: { summary: expect.stringContaining("never publish without approval") },
		});
		h.setResponses([fauxAssistantMessage("review remains pending")]);
		await h.session.prompt("Continue review");
		h.setResponses([
			fauxAssistantMessage("Constraint: never publish without approval. Review pending."),
			fauxAssistantMessage("Review pending; approval required."),
		]);
		await h.session.compact();
		const restored = await createHarness({ sessionFile: h.session.sessionFile!, tools: [] });
		harnesses.push(restored);
		restored.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("never publish without approval");
				return fauxAssistantMessage("Awaiting approval");
			},
		]);
		await restored.session.prompt("Resume");
		expect(restored.session.state.runState).toMatchObject({ lastOutcome: { type: "completed" } });
		expect(restored.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(executions).toBe(1);
	});
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) await h.cleanup();
	});

	it("C02/C03 passes inherited constraints into three consecutive normal summaries", async () => {
		const h = await createHarness();
		harnesses.push(h);
		let previousSummary = "Constraint: never publish without approval.";
		for (let round = 0; round < 3; round++) {
			h.setResponses([
				(context) => {
					expect(JSON.stringify(context)).toContain(JSON.stringify(previousSummary).slice(1, -1));
					return fauxAssistantMessage(`${previousSummary}\nPending step ${round}`);
				},
			]);
			const preparation: CompactionPreparation = {
				firstKeptEntryId: "kept",
				previousSummary,
				isSplitTurn: false,
				tokensBefore: 1000,
				messagesToSummarize: [{ role: "user", content: `next ${round}`, timestamp: round }],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
			};
			const result = await compact(
				preparation,
				h.getModel(),
				"faux-key",
				undefined,
				undefined,
				undefined,
				undefined,
				streamSimple,
			);
			previousSummary = result.summary;
			expect(previousSummary).toContain("never publish without approval");
		}
	});

	it.each(["empty", "boundary", "changed"])(
		"C07/E04 rejects invalid extension commit (%s) without notes",
		async (kind) => {
			const h = await createHarness({
				tools: [],
				settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							if (kind === "changed")
								h.sessionManager.appendMessage({ role: "user", content: "branch changed", timestamp: 2 });
							return {
								compaction: {
									summary: kind === "empty" ? " " : "valid summary",
									firstKeptEntryId: kind === "boundary" ? "missing-id" : event.preparation.firstKeptEntryId,
									tokensBefore: 10,
								},
							};
						});
					},
				],
			});
			harnesses.push(h);
			await h.session.prompt("first");
			await h.session.prompt("second");
			await expect(h.session.compact()).rejects.toThrow("Invalid or stale compaction result");
			expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			expect(existsSync(projectSessionsDir(h.session.memoryStore.rootDir, h.tempDir))).toBe(false);
		},
	);

	it("C04/D02 manual compaction creates one committed snapshot and does not repeat without new input", async () => {
		const h = await createHarness({
			tools: [],
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Approved project convention",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 10,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		await h.session.prompt("first");
		await h.session.prompt("second");
		await h.session.compact();
		const before = h.faux.state.callCount;
		await expect(h.session.compact()).rejects.toThrow("Already compacted");
		expect(h.faux.state.callCount).toBe(before);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			readdirSync(projectSessionsDir(h.session.memoryStore.rootDir, h.tempDir)).filter((name) =>
				name.endsWith(".md"),
			),
		).toHaveLength(1);
	});
	it("C05/E04 rolls back a failed compaction entry write without replacing context or writing notes", async () => {
		const h = await createHarness({
			persistSession: true,
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(h);
		await h.session.prompt("first constraint");
		await h.session.prompt("next step");
		const originalFile = readFileSync(h.session.sessionFile!, "utf8");
		const messages = JSON.stringify(h.session.messages);
		const leaf = h.sessionManager.getLeafId();
		const persist = h.sessionManager._persist.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "_persist").mockImplementation((entry) => {
			if (entry.type === "compaction") throw new Error("simulated disk failure");
			persist(entry);
		});
		h.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("turn summary")]);
		await expect(h.session.compact()).rejects.toThrow("simulated disk failure");
		expect(h.sessionManager.getLeafId()).toBe(leaf);
		expect(h.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(h.session.messages)).toBe(messages);
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(originalFile);
		expect(existsSync(projectSessionsDir(h.session.memoryStore.rootDir, h.tempDir))).toBe(false);
	});

	it.each(["steer", "followUp"] as const)("B03 enforces queued %s input exactly once", async (queue) => {
		let h: Harness;
		let executions = 0;
		const queuedText = "queued constraint ".repeat(20000);
		const tool: AgentTool = {
			name: "queue",
			label: "queue",
			description: "queue",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				await h.session[queue](queuedText);
				return { content: [{ type: "text", text: "queued" }], details: {} };
			},
		};
		h = await createHarness({
			tools: [tool],
			models: [{ id: "small", contextWindow: 20000, maxTokens: 1000 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("queue", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("not sent"),
		]);
		await h.session.prompt("queue input");
		expect(executions).toBe(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
		expect(
			h.session.messages.filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("queued constraint"),
			),
		).toHaveLength(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "delivery_receipt")).toHaveLength(1);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("B02 counts every parallel tool result before sending the next request", async () => {
		const runs: string[] = [];
		const tools: AgentTool[] = ["first", "second"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			execute: async () => {
				runs.push(name);
				return { content: [{ type: "text" as const, text: "stored result\n".repeat(1700) }], details: {} };
			},
		}));
		const h = await createHarness({
			tools,
			models: [{ id: "small", contextWindow: 16000, maxTokens: 1000 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not send"),
		]);
		await h.session.prompt("both");
		expect(runs.sort()).toEqual(["first", "second"]);
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "context_limit" } });
	});

	it("B10 cancels during final transform without provider work", async () => {
		const h = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("context", () => {
						h.session.agent.abort();
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("not sent")]);
		await h.session.prompt("cancel");
		expect(h.getPendingResponseCount()).toBe(1);
		expect(h.session.state.runState).toMatchObject({ lastOutcome: { type: "aborted" } });
	});

	it("D13/E04 reports successful compaction separately when archive extraction fails", async () => {
		const h = await createHarness({
			tools: [],
			settings: { memory: { enabled: true }, compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Durable project convention",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 10,
						},
					}));
				},
			],
		});
		harnesses.push(h);
		await h.session.prompt("first");
		await h.session.prompt("second");
		vi.spyOn(h.session.memoryStore, "maybeConsolidate").mockRejectedValue(new Error("simulated archive failure"));
		await compactOnce(h.session as unknown as CompactionInternals);
		expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({
			aborted: false,
			result: { summary: "Durable project convention" },
		});
		expect(h.session.messages[0].role).toBe("compactionSummary");
		expect(
			h.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "trace" &&
						entry.event.type === "memory/archive" &&
						entry.event.data.reason === "memory_archive_failed",
				),
		).toBe(true);
	});
});
