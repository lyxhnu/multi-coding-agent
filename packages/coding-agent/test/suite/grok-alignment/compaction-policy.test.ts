import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceHash } from "../../../src/core/memory/memory-store.ts";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
	_maybeStartTwoPassPrefire: () => void;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(harness: Harness, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(""),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

/** Seeds a session with enough history that (legacy) shouldCompact() sees it as compactable. */
function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, 100);
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/** Replaces the streamFn so compact()'s summary generation resolves immediately with `summary`. */
function useSummaryStreamFn(harness: Harness, summary: string): void {
	harness.session.agent.streamFunction = (model, context) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(
					context.systemPrompt?.includes("Extract durable")
						? JSON.stringify({
								facts: [
									{
										text: "Durable project decision",
										sourceNoteIds: (
											JSON.parse(context.messages[0].content as string) as Array<{ id: string }>
										).map((note) => note.id),
									},
								],
							})
						: summary,
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("CompactionPolicy wiring (M4)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("records policy/mode/memoryFlush on the compaction entry's details (single-pass by default)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "auto summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compacted = await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntry = harness.sessionManager.getEntries().find((e) => e.type === "compaction");
		expect(compactionEntry?.type).toBe("compaction");
		expect(compacted).toBe(harness.session.agent.hasQueuedMessages());
		const details = compactionEntry?.type === "compaction" ? (compactionEntry.details as any) : undefined;
		expect(details?.grokCompaction?.mode).toBe("single-pass");
		expect(details?.grokCompaction?.policy?.autoCompactThresholdPercent).toBe(85);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "trace" && entry.event.type === "memory/archive"),
		).toBe(false);
	});

	it("actually writes the compaction summary into project memory when memory_flush_enabled is set", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { memoryFlushEnabled: true } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "auto summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const flush = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "trace" && entry.event.type === "memory/archive");
		expect(flush?.type === "trace" ? flush.event.data : undefined).toMatchObject({
			reason: "flush_written",
			written: 1,
		});
		const hits = await harness.session.memoryStore.search("auto summary", "project", harness.tempDir, 10);
		expect(hits.length).toBeGreaterThan(0);
	});

	it('manual flush (spec 10.5 Phase 1: "手动 /memory flush"): flushMemoryNow() summarizes the whole branch and writes to project memory without dropping any messages or appending a compaction entry', async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "manually flushed summary");
		const messagesBefore = harness.session.agent.state.messages.length;

		const result = await harness.session.flushMemoryNow("remember what matters");

		expect(result.attempted).toBe(true);
		expect(result.written).toBe(1);
		// Unlike compact(), a manual flush must not touch the live session at all.
		expect(harness.session.agent.state.messages.length).toBe(messagesBefore);
		expect(harness.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(false);

		const hits = await harness.session.memoryStore.search("manually flushed summary", "project", harness.tempDir, 10);
		expect(hits.length).toBeGreaterThan(0);
	});

	it("manual flush reports attempted:false (rather than throwing) when there is nothing new to summarize", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		// A brand-new session has no messages at all.
		const result = await harness.session.flushMemoryNow();
		expect(result.attempted).toBe(false);
		expect(result.written).toBe(0);
	});

	it("does nothing autoDream-related when memory.enabled is left at its default (false)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "unwitnessed summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		expect(existsSync(harness.session.memoryStore.rootDir)).toBe(false);
	});

	it("autoDream Phase 2 (spec 10.5): writes a session note on every compaction, and consolidates into *project* memory once enough have accumulated, when memory.enabled is on", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { memory: { enabled: true } },
		});
		harnesses.push(harness);
		// Pre-seed 2 session notes "from earlier sessions" so this compaction's own note tips the
		// default minNewSessions=3 threshold, letting us observe consolidation from a single compaction.
		harness.session.memoryStore.writeSessionNote(
			harness.tempDir,
			"earlier-a",
			"sidaaaaaaaa",
			"# earlier session a",
			"compact-a",
		);
		harness.session.memoryStore.writeSessionNote(
			harness.tempDir,
			"earlier-b",
			"sidbbbbbbbb",
			"# earlier session b",
			"compact-b",
		);

		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "dreamable summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const sessionsDir = join(harness.session.memoryStore.rootDir, workspaceHash(harness.tempDir), "sessions");
		const noteFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
		expect(noteFiles.length).toBe(3); // the 2 pre-seeded notes + this compaction's own note

		const consolidated = await harness.session.memoryStore.search(
			"Consolidated memory",
			"project",
			harness.tempDir,
			10,
		);
		expect(consolidated.length).toBeGreaterThan(0);
		const globalHits = await harness.session.memoryStore.search("Consolidated memory", "global", harness.tempDir, 10);
		expect(globalHits).toHaveLength(0); // never auto-writes global (spec 10.5)
	});

	it("fails closed (skips compaction) when compactModel cannot be resolved and strictCompactModel is set", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { compactModel: "does-not-exist/does-not-exist", strictCompactModel: true } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "should never be used");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compacted = await sessionInternals._runAutoCompaction("threshold", false);
		expect(compacted).toBe(false);

		const compactionEntries = harness.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactionEntries).toHaveLength(0);
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd?.errorMessage).toContain("could not be resolved");
		expect(compactionEnd?.errorMessage).toContain("strictCompactModel");
	});

	it("falls back to the current model (with a warning) when compactModel cannot be resolved and strictCompactModel is off", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { compactModel: "does-not-exist/does-not-exist" } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "fallback summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compacted = await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntry = harness.sessionManager.getEntries().find((e) => e.type === "compaction");
		expect(compactionEntry?.type === "compaction" ? compactionEntry.summary : undefined).toContain(
			"fallback summary",
		);
		expect(compacted).toBe(harness.session.agent.hasQueuedMessages());
		const details = compactionEntry?.type === "compaction" ? (compactionEntry.details as any) : undefined;
		expect(details?.compactModelWarning).toContain("could not be resolved");
	});

	it("two-pass compaction (spec 9.5): pass 1's speculative prefix summary is persisted to a session custom entry and reused by pass 2", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { twoPassEnabled: true } },
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "prefire prefix summary");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		// Pass 1: fires speculatively (in this test, invoked directly rather than via the 75%-usage
		// trigger check — see shouldPrefireTwoPass's own coverage in compaction-policy.test.ts at the repo
		// root for that threshold logic). It runs as a fire-and-forget background task, so poll for its
		// result rather than assuming it has landed synchronously.
		sessionInternals._maybeStartTwoPassPrefire();
		let prefireEntry: unknown;
		for (let i = 0; i < 40 && !prefireEntry; i++) {
			prefireEntry = harness.sessionManager
				.getEntries()
				.find((e) => e.type === "custom" && e.customType === "two-pass-prefire");
			if (!prefireEntry) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(prefireEntry).toBeTruthy();
		expect((prefireEntry as { data?: { summary?: string } }).data?.summary).toContain("prefire prefix summary");

		// Pass 2: the real compaction should now report mode "two-pass" (it reused pass 1's prefix
		// summary rather than summarizing cold).
		useSummaryStreamFn(harness, "pass 2 tail summary");
		await sessionInternals._runAutoCompaction("threshold", false);
		const compactionEntry = harness.sessionManager.getEntries().find((e) => e.type === "compaction");
		const details = compactionEntry?.type === "compaction" ? (compactionEntry.details as any) : undefined;
		expect(details?.grokCompaction?.mode).toBe("two-pass");
	});
});
