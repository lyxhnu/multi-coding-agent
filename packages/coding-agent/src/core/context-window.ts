import { randomUUID } from "node:crypto";
import type { SessionEntry } from "./session-manager.ts";

export interface ContextWindowIdentity {
	windowId: string;
	previousWindowId: string | null;
}

export function currentContextWindow(branch: readonly SessionEntry[]): ContextWindowIdentity | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "context_window" || entry.type === "context_rollover" || entry.type === "compaction") {
			return { windowId: entry.windowId, previousWindowId: entry.previousWindowId };
		}
	}
	return undefined;
}

export function createContextWindowIdentity(branch: readonly SessionEntry[]): ContextWindowIdentity {
	return { windowId: randomUUID(), previousWindowId: currentContextWindow(branch)?.windowId ?? null };
}

export function formatContextWindow(windowId: string, resumeRef?: string): string {
	if (!/^[a-f0-9-]{36}$/i.test(windowId) || (resumeRef !== undefined && !/^[a-f0-9-]{36}$/i.test(resumeRef))) {
		throw new Error("Invalid context window identity");
	}
	return [
		"<context_window>",
		`window_id: ${windowId}`,
		...(resumeRef === undefined ? [] : [`resume_ref: ${resumeRef}`]),
		resumeRef === undefined
			? "Save important task changes with context_note. Use get_context_remaining to inspect the request budget and new_context to request a new window."
			: "Continue the current task. Resolve the resume reference with context_note query (resumeRef).",
		"Read the effective task requirements before dependent work; load details as needed.",
		"</context_window>",
	].join("\n");
}
