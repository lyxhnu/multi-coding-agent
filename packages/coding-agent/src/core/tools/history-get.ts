import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { collectShakeRedactions, type SessionManager } from "../session-manager.ts";

export const HISTORY_DEFAULT_LIMIT = 4000;
export const HISTORY_MAX_LIMIT = 8000;
const historyGetSchema = Type.Object(
	{
		entryId: Type.String({ minLength: 1 }),
		blockIndex: Type.Optional(Type.Integer({ minimum: -1 })),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_MAX_LIMIT })),
	},
	{ additionalProperties: false },
);
export type HistoryGetInput = Static<typeof historyGetSchema>;

export function createHistoryGetToolDefinition(manager: SessionManager): ToolDefinition<typeof historyGetSchema> {
	return {
		name: "history_get",
		label: "history_get",
		description:
			"Read saved text of a shaken entry on this session branch. Never re-executes tools. Offsets/limits count Unicode code points; default 4000, maximum 8000. Cannot recover content truncated before it was saved. Multiple text blocks require blockIndex; -1 selects string content.",
		promptSnippet: "Read original shaken history without re-running tools",
		parameters: historyGetSchema,
		async execute(_id, input, signal) {
			signal?.throwIfAborted();
			const offset = input.offset ?? 0;
			const limit = input.limit ?? HISTORY_DEFAULT_LIMIT;
			if (
				!Number.isInteger(offset) ||
				offset < 0 ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > HISTORY_MAX_LIMIT ||
				(input.blockIndex !== undefined && (!Number.isInteger(input.blockIndex) || input.blockIndex < -1))
			)
				throw new Error("Invalid history pagination");
			const branch = manager.getBranch();
			const entry = branch.find((item) => item.id === input.entryId);
			const redactions = collectShakeRedactions(branch).filter((item) => item.targetId === input.entryId);
			const latestRollover = [...branch].reverse().find((item) => item.type === "context_rollover");
			const handoffAuthorization =
				latestRollover?.type === "context_rollover"
					? latestRollover.bundle.historyAllowlist.find((item) => item.entryId === input.entryId)
					: undefined;
			if (
				!entry ||
				(redactions.length === 0 && handoffAuthorization === undefined) ||
				(entry.type !== "message" && entry.type !== "custom_message")
			) {
				throw new Error("History source is not authorized on this branch");
			}
			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				["memory_get", "memory_search"].includes(entry.message.toolName)
			)
				throw new Error("Historical memory results cannot be replayed; query the current memory view");
			const content =
				entry.type === "custom_message"
					? entry.content
					: "content" in entry.message
						? entry.message.content
						: undefined;
			const blocks: Array<{ index: number; text: string }> = [];
			if (typeof content === "string") blocks.push({ index: -1, text: content });
			else if (Array.isArray(content))
				content.forEach((block, index) => {
					if (block.type === "text") blocks.push({ index, text: block.text });
				});
			const allowed = blocks.filter(
				(block) =>
					redactions.some(
						(redaction) => redaction.kind === "toolResult" || redaction.blockIndex === block.index,
					) ||
					(handoffAuthorization !== undefined &&
						(handoffAuthorization.blockIndex === block.index ||
							(handoffAuthorization.blockIndex === undefined && blocks.length === 1))),
			);
			if (input.blockIndex === undefined && allowed.length !== 1)
				throw new Error("Specify blockIndex for a source with multiple readable text blocks");
			const block =
				input.blockIndex === undefined ? allowed[0] : allowed.find((item) => item.index === input.blockIndex);
			if (!block) throw new Error("History block is not readable");
			const characters = Array.from(block.text);
			if (offset > characters.length) throw new Error("History offset is beyond the saved content");
			const end = Math.min(characters.length, offset + limit);
			const details = {
				entryId: entry.id,
				blockIndex: block.index,
				unit: "unicode_code_points",
				offset,
				end,
				total: characters.length,
				nextOffset: end < characters.length ? end : null,
				savedContentOnly: true,
			};
			return {
				content: [
					{ type: "text", text: JSON.stringify({ ...details, text: characters.slice(offset, end).join("") }) },
				],
				details,
			};
		},
	};
}
