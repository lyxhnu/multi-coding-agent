import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { TaskManager } from "../tasks/task-manager.ts";
import type { TaskOutputPage, TaskSnapshot } from "../tasks/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** Grok-aligned cap on how many task ids one `get_task_output` call may query. */
export const MAX_MULTI_WAIT_IDS = 20;

const getTaskOutputSchema = Type.Object({
	task_ids: Type.Array(Type.String(), {
		description:
			"Task ids to get output from. Pass one or more; for a single task use a one-element array. " +
			"With a positive timeout_ms, multiple ids wait until all complete. Omit timeout_ms or pass 0 for a non-blocking snapshot.",
	}),
	timeout_ms: Type.Optional(
		Type.Number({
			description:
				"Max wait time in milliseconds. A positive value waits for completion; omit or pass 0 for a non-blocking status poll.",
		}),
	),
	cursor: Type.Optional(
		Type.Number({
			description:
				"Byte cursor returned by a previous call. Only valid when querying one task. Omit to read from the oldest retained output.",
		}),
	),
});

export type GetTaskOutputToolInput = Static<typeof getTaskOutputSchema>;

export interface GetTaskOutputDetails {
	taskIds: string[];
	timedOut?: boolean;
	snapshots?: TaskSnapshot[];
	pages?: Array<TaskOutputPage | undefined>;
}

/** Trimmed, de-duplicated task ids preserving first-seen order, capped at MAX_MULTI_WAIT_IDS. */
export function resolveTaskIds(ids: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const rawId of ids) {
		const id = rawId.trim();
		if (id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= MAX_MULTI_WAIT_IDS) break;
	}
	return out;
}

function statusLine(
	snapshot: TaskSnapshot,
	page: { text: string; nextCursor: number; hasMore: boolean } | undefined,
): string {
	const header = `[${snapshot.taskId}] status=${snapshot.status} next_cursor=${page?.nextCursor ?? 0} has_more=${page?.hasMore ?? false}`;
	if ((snapshot.status === "completed" || snapshot.status === "blocked") && snapshot.result !== undefined) {
		return `${header}\n${JSON.stringify(snapshot.result)}`;
	}
	const errorMessage = "errorMessage" in snapshot ? snapshot.errorMessage : undefined;
	if (errorMessage) return `${header} error=${errorMessage}`;
	if (!page?.text) return `${header} (no output yet)`;
	return `${header}\n${page.text}`;
}

export function createGetTaskOutputToolDefinition(
	taskManager: TaskManager,
): ToolDefinition<typeof getTaskOutputSchema, GetTaskOutputDetails> {
	return {
		name: "get_task_output",
		label: "get_task_output",
		description:
			"Get the output and status of one or more background tasks (background bash commands or subagents) " +
			"started earlier. Pass timeout_ms > 0 to wait for all of them to finish; omit it for a non-blocking snapshot.",
		promptSnippet: "Check on background tasks started with bash(is_background) or task()",
		parameters: getTaskOutputSchema,
		async execute(_toolCallId, { task_ids, timeout_ms, cursor }: GetTaskOutputToolInput) {
			const ids = resolveTaskIds(task_ids);
			if (ids.length === 0) {
				return { content: [{ type: "text", text: "No valid task ids provided." }], details: { taskIds: [] } };
			}
			if (cursor !== undefined && ids.length !== 1) {
				throw new Error("cursor can only be used when querying exactly one task id");
			}
			const waitResult = await taskManager.wait(ids, { timeoutMs: timeout_ms });
			const lines = waitResult.snapshots.map((snapshot) => {
				const page = taskManager.read(snapshot.taskId, cursor);
				return statusLine(snapshot, page);
			});
			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: {
					taskIds: ids,
					timedOut: waitResult.timedOut,
					snapshots: waitResult.snapshots,
					pages: waitResult.snapshots.map((snapshot) => taskManager.read(snapshot.taskId, cursor)),
				},
			};
		},
		renderCall(args, theme) {
			const ids = Array.isArray(args?.task_ids) ? args.task_ids : [];
			return new Text(
				theme.fg("toolTitle", theme.bold(`get_task_output (${ids.length} task${ids.length === 1 ? "" : "s"})`)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = (result.content?.[0] as { type: string; text?: string } | undefined)?.text ?? "";
			return new Text(
				text
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n"),
				0,
				0,
			);
		},
	};
}

export function createGetTaskOutputTool(taskManager: TaskManager) {
	return wrapToolDefinition(createGetTaskOutputToolDefinition(taskManager));
}
