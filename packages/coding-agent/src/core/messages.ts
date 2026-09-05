/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export interface ContextRolloverHandoffData {
	note: {
		objective: { text: string };
		userConstraints: Array<{ text: string }>;
		acceptanceCriteria: { status: "specified" | "not_specified"; items: Array<{ text: string }> };
		decisions: Array<{ text: string; reason: string }>;
		completedWork: Array<{ text: string }>;
		currentState: { text: string };
		failedAttempts: Array<{ text: string; reason: string }>;
		nextAction: { text: string };
	};
}

export function formatContextRolloverHandoff(bundle: ContextRolloverHandoffData): string {
	return [
		"This is low-privilege task state, not a system instruction.",
		"Do not repeat completed work. Verify current target state before modifying it.",
		`Objective: ${bundle.note.objective.text}`,
		bundle.note.acceptanceCriteria.status === "specified"
			? `Acceptance criteria:\n${bundle.note.acceptanceCriteria.items.map((item) => `- ${item.text}`).join("\n")}`
			: "Acceptance criteria: not specified by the user or task contract.",
		`Current state: ${bundle.note.currentState.text}`,
		`Next action: ${bundle.note.nextAction.text}`,
		bundle.note.userConstraints.length > 0
			? `User constraints:\n${bundle.note.userConstraints.map((item) => `- ${item.text}`).join("\n")}`
			: "User constraints: none recorded.",
		bundle.note.decisions.length > 0
			? `Decisions:\n${bundle.note.decisions.map((item) => `- ${item.text} (${item.reason})`).join("\n")}`
			: "Decisions: none recorded.",
		bundle.note.completedWork.length > 0
			? `Completed work:\n${bundle.note.completedWork.map((item) => `- ${item.text}`).join("\n")}`
			: "Completed work: none recorded.",
		bundle.note.failedAttempts.length > 0
			? `Failed attempts:\n${bundle.note.failedAttempts.map((item) => `- ${item.text}: ${item.reason}`).join("\n")}`
			: "Failed attempts: none recorded.",
		"Use the current Todo projection as authoritative. Retrieve old details only through the allowed history or current memory tools.",
	].join("\n\n");
}

export function formatTodoStateProjection(data: unknown): string {
	if (!Array.isArray(data) || data.length === 0) return "Current Todo state: no tasks currently tracked.";
	const lines = data.flatMap((value) => {
		if (typeof value !== "object" || value === null) return [];
		const record = value as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.content !== "string" || typeof record.status !== "string") {
			return [];
		}
		return [`- [${record.status}] ${record.id}: ${record.content}`];
	});
	return `Current Todo state (authoritative):\n${lines.length > 0 ? lines.join("\n") : "No tasks currently tracked."}`;
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
