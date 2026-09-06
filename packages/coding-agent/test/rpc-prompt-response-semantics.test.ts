import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory(tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, tempDir);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		memoryRootDir: join(tempDir, "memory"),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: { withAuth: boolean; responseDelayMs: number; model?: Model<any> }): Promise<{
	lineHandler: (line: string) => void;
	runHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runHost: runtimeHost, cleanup };
}

describe("RPC prompt response semantics", () => {
	it("serializes running tool-call IDs as a JSON array", async () => {
		const { lineHandler, runHost, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const state = vi.spyOn(runHost.session.agent.state, "runState", "get").mockReturnValue({
			status: "running",
			runId: 1,
			turn: 0,
			phase: { type: "executing_tools", pendingToolCallIds: new Set(["call-a", "call-b"]) },
		});
		try {
			lineHandler(JSON.stringify({ id: "running-state", type: "get_state" }));
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						id: "running-state",
						data: expect.objectContaining({
							windowId: runHost.session.contextRolloverState.windowId,
							runState: {
								status: "running",
								runId: 1,
								turn: 0,
								phase: { type: "executing_tools", pendingToolCallIds: ["call-a", "call-b"] },
							},
						}),
					}),
				),
			);
		} finally {
			state.mockRestore();
			await cleanup();
		}
	});
	it("E05/M03 returns flush rejections and applies undo through the same memory store", async () => {
		const { lineHandler, runHost, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			const session = runHost.session;
			session.sessionManager.appendMessage({ role: "user", content: "remember project decisions", timestamp: 1 });
			session.sessionManager.appendMessage(createAssistantMessage("pending"));
			session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			session.agent.streamFunction = () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() =>
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("API_KEY=simulated-rpc-secret"),
					}),
				);
				return stream;
			};
			lineHandler(JSON.stringify({ id: "flush", type: "memory_flush" }));
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						id: "flush",
						success: true,
						data: expect.objectContaining({
							attempted: true,
							written: 0,
							skipped: 1,
							reasons: ["secret_pattern"],
						}),
					}),
				),
			);
			expect(rpcIo.outputLines.join("")).not.toContain("simulated-rpc-secret");
			const cwd = session.sessionManager.getCwd();
			const { ids } = session.memoryStore.appendProject(cwd, ["obsolete test convention"]);
			lineHandler(JSON.stringify({ id: "undo", type: "memory_undo", scope: "project", entryId: ids[0] }));
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ id: "undo", success: true, data: { undone: true } }),
				),
			);
			expect(await session.memoryStore.search("obsolete", "project", cwd)).toEqual([]);
		} finally {
			await cleanup();
		}
	});
	it("B09/E06 preserves context_limit as an event and get_state outcome, not completion", async () => {
		const { lineHandler, runHost, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		try {
			runHost.session.setAutoCompactionEnabled(false);
			lineHandler(
				JSON.stringify({
					id: "limited",
					type: "prompt",
					message: "x".repeat(runHost.session.model!.contextWindow * 4),
				}),
			);
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						type: "agent_end",
						outcome: expect.objectContaining({ type: "context_limit" }),
					}),
				),
			);
			lineHandler(JSON.stringify({ id: "limited-state", type: "get_state" }));
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						command: "get_state",
						data: expect.objectContaining({
							runState: expect.objectContaining({
								status: "idle",
								lastOutcome: expect.objectContaining({ type: "context_limit" }),
							}),
						}),
					}),
				),
			);
			expect(runHost.session.messages.some((message) => message.role === "assistant")).toBe(false);
			expect(getPromptResponses(rpcIo.outputLines, "limited")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});

describe("RPC memory_flush / memory_undo (spec 10.5/10.6)", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("memory_flush responds with attempted:false (not an error) when there is nothing to summarize yet", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "mf1", type: "memory_flush" }));

			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "mf1" && record.type === "response" && record.command === "memory_flush",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "mf1",
					type: "response",
					command: "memory_flush",
					success: true,
					data: { attempted: false, written: 0 },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("memory_undo tombstones a previously written project memory entry, reachable end-to-end through the RPC protocol", async () => {
		const { lineHandler, runHost, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			const cwd = runHost.session.sessionManager.getCwd();
			const appended = runHost.session.memoryStore.appendProject(cwd, ["Always run tests before committing."]);
			expect(appended.written).toBe(1);
			const entryId = appended.ids[0]!;

			lineHandler(JSON.stringify({ id: "mu1", type: "memory_undo", scope: "project", entryId }));

			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "mu1" && record.type === "response" && record.command === "memory_undo",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ success: true, data: { undone: true } });
			});

			expect(await runHost.session.memoryStore.search("run tests", "project", cwd, 10)).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("memory_undo responds with undone:false for an unknown id, never throwing", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "mu2", type: "memory_undo", scope: "global", entryId: "mem-doesnotexist" }));

			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "mu2" && record.type === "response" && record.command === "memory_undo",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ success: true, data: { undone: false } });
			});
		} finally {
			await cleanup();
		}
	});
});
