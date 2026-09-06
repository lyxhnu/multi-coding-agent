export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	type ContextNoteToolDetails,
	type ContextNoteToolInput,
	type ContextNoteToolOptions,
	createContextNoteToolDefinition,
} from "./context-note.ts";
export { createContextRemainingToolDefinition, createNewContextToolDefinition } from "./context-window.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGetTaskOutputTool,
	createGetTaskOutputToolDefinition,
	type GetTaskOutputToolInput,
	MAX_MULTI_WAIT_IDS,
	resolveTaskIds,
} from "./get-task-output.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export { createHistoryToolDefinition } from "./history.ts";
export { createKillTaskTool, createKillTaskToolDefinition, type KillTaskToolInput } from "./kill-task.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createTodoWriteTool,
	createTodoWriteToolDefinition,
	type TodoWriteToolDetails,
	type TodoWriteToolInput,
	type TodoWriteToolOptions,
} from "./todo-write.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { TaskManager } from "../tasks/task-manager.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGetTaskOutputTool, createGetTaskOutputToolDefinition } from "./get-task-output.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createKillTaskTool, createKillTaskToolDefinition } from "./kill-task.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createTodoWriteTool, createTodoWriteToolDefinition, type TodoWriteToolOptions } from "./todo-write.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "todo_write"
	| "get_task_output"
	| "kill_task";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"todo_write",
	"get_task_output",
	"kill_task",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	todoWrite?: TodoWriteToolOptions;
	/** Shared task registry for background bash, get_task_output, and kill_task. Defaults to a fresh, session-scoped TaskManager when omitted. */
	taskManager?: TaskManager;
}

function resolveTaskManager(options: ToolsOptions | undefined): TaskManager {
	return options?.taskManager ?? options?.bash?.taskManager ?? new TaskManager();
}

function bashOptionsWithTaskManager(options: ToolsOptions | undefined): BashToolOptions | undefined {
	const taskManager = resolveTaskManager(options);
	return { ...options?.bash, taskManager: options?.bash?.taskManager ?? taskManager };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, bashOptionsWithTaskManager(options));
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "todo_write":
			return createTodoWriteToolDefinition(cwd, options?.todoWrite);
		case "get_task_output":
			return createGetTaskOutputToolDefinition(resolveTaskManager(options));
		case "kill_task":
			return createKillTaskToolDefinition(resolveTaskManager(options));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, bashOptionsWithTaskManager(options));
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "todo_write":
			return createTodoWriteTool(cwd, options?.todoWrite);
		case "get_task_output":
			return createGetTaskOutputTool(resolveTaskManager(options));
		case "kill_task":
			return createKillTaskTool(resolveTaskManager(options));
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, bashOptionsWithTaskManager(options)),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const taskManager = resolveTaskManager(options);
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, { ...options?.bash, taskManager: options?.bash?.taskManager ?? taskManager }),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		todo_write: createTodoWriteToolDefinition(cwd, options?.todoWrite),
		get_task_output: createGetTaskOutputToolDefinition(taskManager),
		kill_task: createKillTaskToolDefinition(taskManager),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, bashOptionsWithTaskManager(options)),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const taskManager = resolveTaskManager(options);
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, { ...options?.bash, taskManager: options?.bash?.taskManager ?? taskManager }),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		todo_write: createTodoWriteTool(cwd, options?.todoWrite),
		get_task_output: createGetTaskOutputTool(taskManager),
		kill_task: createKillTaskTool(taskManager),
	};
}
