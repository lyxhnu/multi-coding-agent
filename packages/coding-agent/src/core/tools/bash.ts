import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { SandboxBuildResult, SandboxManager } from "../sandbox/sandbox-manager.ts";
import type { ResolvedSandboxSettings } from "../sandbox/types.ts";
import type { TaskManager } from "../tasks/task-manager.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	/**
	 * Grok-aligned (spec 4.1/15.1): milliseconds by default. Enable BashToolOptions.legacyTimeoutSeconds
	 * (settings: bash.legacyTimeoutSeconds) during the migration window to interpret this as seconds
	 * instead, matching pi's original unit.
	 */
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in milliseconds (Grok-aligned; e.g. 120000 for 2 minutes). Optional — omit for no timeout.",
		}),
	),
	/** Grok-aligned: one-sentence explanation of why this command is being run. Purely informational; never affects execution. */
	description: Type.Optional(
		Type.String({ description: "One sentence explanation of why this command needs to be run." }),
	),
	/** Grok-aligned `is_background`: run detached, returning a task id immediately instead of blocking. Requires a TaskManager (see BashToolOptions.taskManager). */
	is_background: Type.Optional(
		Type.Boolean({
			description:
				"Set to true for long-running commands that should run in the background (e.g. dev servers, long builds). " +
				"Returns a task id immediately; use get_task_output to check on it and kill_task to cancel it.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: {
	shellPath?: string;
	/**
	 * Grok-aligned sandbox wrapping (spec 12), opt-in: when provided, every spawned shell is wrapped
	 * through SandboxManager.build() first. Omitted (the default for every existing caller) leaves
	 * behavior completely unchanged — no wrapping, no sandbox-exec/bwrap dependency.
	 */
	sandbox?: {
		manager: SandboxManager;
		settings: ResolvedSandboxSettings;
		/** Called (spec 12: "off 必须审计") whenever the resolved profile is "off", with a redacted command for logging. */
		onSandboxOff?: (redactedCommand: string) => void;
	};
}): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const baseArgs = commandFromStdin ? shellConfig.args : [...shellConfig.args, command];
			let spawnCommand: string = shellConfig.shell;
			let spawnArgs: string[] = baseArgs;
			if (options?.sandbox) {
				const built: SandboxBuildResult = options.sandbox.manager.build(
					shellConfig.shell,
					baseArgs,
					options.sandbox.settings,
				);
				if (!built.ok) {
					throw new Error(`Sandbox denied this command: ${built.reason}`);
				}
				if (built.auditRequired) {
					options.sandbox.onSandboxOff?.(command);
				}
				spawnCommand = built.wrapped.command;
				spawnArgs = built.wrapped.args;
			}
			const child = spawn(spawnCommand, spawnArgs, {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Shared task registry backing `is_background` and `autoBackgroundOnTimeout`.
	 * Without one, `is_background: true` throws and `autoBackgroundOnTimeout` is inert.
	 */
	taskManager?: TaskManager;
	/** Whether `is_background` is honored at all. Default: true (when `taskManager` is set). */
	enabledBackground?: boolean;
	/**
	 * When true (and `enabledBackground`), a foreground command that hits
	 * `foregroundBlockBudgetMs` is moved to the background instead of being killed.
	 * The underlying process keeps running under `taskManager`; `timeout` (if set)
	 * still applies as the hard kill deadline. Default: false.
	 */
	autoBackgroundOnTimeout?: boolean;
	/** Foreground wait budget before auto-backgrounding, in milliseconds. Default: 15000. */
	foregroundBlockBudgetMs?: number;
	/**
	 * Grok-aligned sandbox wrapping (spec 12), opt-in: forwarded to createLocalBashOperations() when
	 * `operations` isn't overridden. Omitted (the default) leaves bash execution completely unsandboxed,
	 * exactly as before this feature existed.
	 */
	sandbox?: {
		manager: SandboxManager;
		settings: ResolvedSandboxSettings;
		onSandboxOff?: (redactedCommand: string) => void;
	};
	/**
	 * Migration flag (spec 15.1): when true, `timeout` is interpreted as *seconds* (pi's original unit)
	 * instead of milliseconds (Grok-aligned default). Default: false.
	 */
	legacyTimeoutSeconds?: boolean;
}

const DEFAULT_FOREGROUND_BLOCK_BUDGET_MS = 15_000;

/**
 * Starts `command` as a task-manager-backed task. Shared by the `is_background: true`
 * path and the `autoBackgroundOnTimeout` foreground-then-background path: both need the
 * task's own AbortController (not the tool call's) to be the thing that actually controls
 * `ops.exec`, so `kill_task` can cancel the real process, and both need the original tool-call
 * `signal` (session-level abort) to also cancel the task.
 */
function startBashTask(
	ops: BashOperations,
	spawnContext: BashSpawnContext,
	taskManager: TaskManager,
	timeout: number | undefined,
	description: string,
	externalSignal: AbortSignal | undefined,
): string {
	const snapshot = taskManager.start({
		kind: "bash",
		cwd: spawnContext.cwd,
		description,
		run: async (taskCtx) => {
			const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
				onData: (data) => taskCtx.appendOutput(data.toString()),
				signal: taskCtx.signal,
				timeout,
				env: spawnContext.env,
			});
			return { status: "completed", exitCode: result.exitCode };
		},
	});
	if (externalSignal) {
		const onExternalAbort = () => taskManager.cancel(snapshot.taskId, "aborted");
		if (externalSignal.aborted) onExternalAbort();
		else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	}
	return snapshot.taskId;
}

/** Formats a task-manager-backed task's currently retained output the same way foreground bash output is formatted (tail-truncated). */
function formatTaskOutputText(taskManager: TaskManager, taskId: string): string {
	const page = taskManager.read(taskId);
	const raw = page?.text ?? "";
	if (!raw) return "(no output yet)";
	const truncation = truncateTail(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return truncation.content;
	return `${truncation.content}\n\n[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines. Full output via get_task_output(task_ids=["${taskId}"]).]`;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	// Grok-aligned default unit is milliseconds (spec 4.1/15.1); legacyTimeoutSeconds sessions display
	// a slightly inaccurate unit here since this pure render helper has no settings access, which is an
	// acceptable, display-only tradeoff during the migration window.
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}ms)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops =
		options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath, sandbox: options?.sandbox });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const taskManager = options?.taskManager;
	const enabledBackground = options?.enabledBackground ?? true;
	const autoBackgroundOnTimeout = options?.autoBackgroundOnTimeout ?? false;
	const foregroundBlockBudgetMs = options?.foregroundBlockBudgetMs ?? DEFAULT_FOREGROUND_BLOCK_BUDGET_MS;
	const legacyTimeoutSeconds = options?.legacyTimeoutSeconds ?? false;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in milliseconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: exposeSessionEnvironment
			? ["Inspect PI_* environment variables for current model and session details."]
			: undefined,
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{
				command,
				timeout,
				is_background,
				description,
			}: { command: string; timeout?: number; is_background?: boolean; description?: string },
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			// Grok-aligned timeout migration (spec 15.1): `timeout` is milliseconds by default; the internal
			// pipeline below still thinks in seconds (unchanged, to minimize risk), so convert once here.
			const timeoutSeconds = timeout === undefined ? undefined : legacyTimeoutSeconds ? timeout : timeout / 1000;
			const timeoutMigrationWarning =
				!legacyTimeoutSeconds && timeout !== undefined && timeout > 0 && timeout < 1000
					? `[timeout unit notice] "timeout" is milliseconds now (Grok-aligned); ${timeout} is unusually small under that unit. If you meant ${timeout} seconds, pass timeout: ${timeout * 1000}. Set bash.legacyTimeoutSeconds=true in settings to keep the old seconds-based behavior during the migration window.`
					: undefined;
			const withTimeoutWarning = (text: string) =>
				timeoutMigrationWarning ? `${timeoutMigrationWarning}\n\n${text}` : text;
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook, exposeSessionEnvironment, ctx);

			// Grok-aligned background execution: returns immediately with a task id instead
			// of blocking. Requires a TaskManager; without one this is a clear, immediate error
			// rather than silently running in the foreground (which would violate the caller's
			// explicit request not to block).
			if (is_background) {
				if (!enabledBackground || !taskManager) {
					throw new Error(
						"Background execution (is_background: true) is not available in this context (no task manager configured).",
					);
				}
				const taskId = startBashTask(
					ops,
					spawnContext,
					taskManager,
					timeoutSeconds,
					description ?? command,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: withTimeoutWarning(
								`Started background task ${taskId}.\nUse get_task_output with task_ids=["${taskId}"] to check on it, or kill_task to cancel it. You are not notified automatically; poll when you need the result.`,
							),
						},
					],
					details: undefined,
				};
			}

			// Grok-aligned auto-background-on-timeout: if the command hasn't finished within
			// `foregroundBlockBudgetMs`, hand the caller a task id instead of killing it. The
			// hard `timeout` (if any) still applies and will kill the process once reached,
			// regardless of whether it has already been handed off to the background.
			if (enabledBackground && autoBackgroundOnTimeout && taskManager) {
				const taskId = startBashTask(
					ops,
					spawnContext,
					taskManager,
					timeoutSeconds,
					description ?? command,
					signal,
				);
				const waitResult = await taskManager.wait([taskId], { timeoutMs: foregroundBlockBudgetMs });
				const first = waitResult.snapshots[0];
				if (first && (first.status === "running" || first.status === "cancelling")) {
					return {
						content: [
							{
								type: "text",
								text: withTimeoutWarning(
									`Command is still running after ${foregroundBlockBudgetMs}ms; moved to background as task ${taskId}.\nUse get_task_output with task_ids=["${taskId}"] to check on it, or kill_task to cancel it.`,
								),
							},
						],
						details: undefined,
					};
				}
				const outputText = formatTaskOutputText(taskManager, taskId);
				if (first?.status === "failed" || first?.status === "cancelled" || first?.status === "blocked") {
					throw new Error(`${outputText}\n\n${first.errorMessage ?? `Command ${first.status}`}`);
				}
				if (
					first?.status === "completed" &&
					first.exitCode !== 0 &&
					first.exitCode !== null &&
					first.exitCode !== undefined
				) {
					throw new Error(`${outputText}\n\nCommand exited with code ${first.exitCode}`);
				}
				return { content: [{ type: "text", text: withTimeoutWarning(outputText) }], details: undefined };
			}

			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout: timeoutSeconds,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: withTimeoutWarning(outputText) }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
