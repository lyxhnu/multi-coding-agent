/**
 * Mechanical context reduction ("shake").
 *
 * Compaction buys space by asking a model to summarize history: it costs a request, a wall-clock
 * budget, and it rewrites the whole prefix. Shake buys space for free — it locates the heaviest
 * regions still in context (whole tool results, large fenced/XML blocks) and replaces them with a
 * one-line placeholder. No model call, no summary, deterministic.
 *
 * This module is the pure layer: detection and redaction *computation* only, no I/O and no
 * mutation of its inputs. Persistence and context rebuilding are the caller's job (see
 * `AgentSession.shake`), which matters because pi's session log is append-only — an in-place edit
 * of a stored entry would be lost on the next load. Callers therefore persist the returned
 * {@link ShakeRedaction} list and replay it during context construction.
 *
 * Layering mirrors `compaction.ts`: operates on a structural entry shape so both the harness
 * session tree and the coding-agent session manager can feed it without either package depending
 * on the other.
 */

import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

/**
 * Tool-result protection. A string protects every result from that tool by name; a predicate may
 * inspect the result itself.
 */
export type ProtectedToolMatcher = string | ((message: ToolResultMessage) => boolean);

export interface ShakeConfig {
	/** Keep the most recent context tokens intact — the agent is actively working from them. */
	protectTokens: number;
	/** Only shake when total estimated savings meets this threshold. */
	minSavings: number;
	/** Tool results never eligible for shaking. */
	protectedTools: ProtectedToolMatcher[];
	/** Minimum token size for a fenced/XML block to be eligible. */
	fenceMinTokens: number;
	/**
	 * Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries before it are
	 * summarized away and never sent, so shaking them only churns persisted history for no
	 * prompt-size gain. Undefined = no compaction, the whole branch is in play.
	 */
	keepBoundaryId?: string;
	/**
	 * Prompt-cache guard: skip entries with more than this many tokens after them.
	 *
	 * Deliberately the opposite direction from {@link protectTokens}. A deep entry (lots of context
	 * after it) sits inside the byte prefix the provider has already cached; rewriting it forfeits
	 * that cache and bills a fresh cache write, which can cost more than the tokens it saves. So
	 * `protectTokens` fences off the newest end and this fences off the oldest end, leaving a middle
	 * band eligible. `undefined` disarms the guard (whole history eligible).
	 *
	 * Requires a value above `protectTokens` or the band is empty; {@link resolveShakeConfig}
	 * disarms and warns rather than letting shake silently become a no-op.
	 */
	cacheWarmSuffixTokens?: number;
}

/**
 * Tool results whose content the agent depends on structurally rather than informationally.
 * `todo_write` echoes the live todo list and plan-mode results carry standing constraints; blanking
 * either strands the agent without the state it is steering by.
 */
const DEFAULT_PROTECTED_TOOLS: ProtectedToolMatcher[] = ["todo_write", "enter_plan_mode", "exit_plan_mode"];

/** Automatic shake: protects the live tail, conservative savings floor, cache guard armed. */
export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 16_000,
	minSavings: 4_000,
	protectedTools: DEFAULT_PROTECTED_TOOLS,
	fenceMinTokens: 400,
	cacheWarmSuffixTokens: 100_000,
};

/**
 * Manual `/shake`: no savings floor and no cache guard — the user asked for space and can accept a
 * cache write. Still keeps a small recent tail so it cannot strip the results being worked from.
 */
export const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 4_000,
	minSavings: 0,
	protectedTools: DEFAULT_PROTECTED_TOOLS,
	fenceMinTokens: 400,
};

/**
 * Last resort, once the mid-prompt compaction budget is spent. `protectTokens: 0` is the point:
 * the blocker is usually the newest oversized result, and a recovery that cannot drop its blocker
 * is not a recovery.
 */
export const RESCUE_SHAKE_CONFIG: ShakeConfig = {
	...AGGRESSIVE_SHAKE_CONFIG,
	protectTokens: 0,
};

/**
 * Normalize a config, disarming a cache guard that would leave no eligible band.
 *
 * `cacheWarmSuffixTokens <= protectTokens` makes every entry fail one window or the other, so
 * shake would return nothing and look like "there was nothing to shake". Failing loudly here beats
 * a silent no-op that only shows up as an unexplained truncation later.
 */
export function resolveShakeConfig(config: ShakeConfig, onWarning?: (message: string) => void): ShakeConfig {
	if (config.cacheWarmSuffixTokens !== undefined && config.cacheWarmSuffixTokens <= config.protectTokens) {
		onWarning?.(
			`shake: cacheWarmSuffixTokens (${config.cacheWarmSuffixTokens}) must exceed protectTokens (${config.protectTokens}); disarming the prompt-cache guard`,
		);
		return { ...config, cacheWarmSuffixTokens: undefined };
	}
	return config;
}

/**
 * The entry fields shake reads. Both the harness `SessionTreeEntry` union and the coding-agent
 * `SessionEntry` union satisfy this structurally, so neither package has to import the other's
 * session model.
 */
export interface ShakeCandidateEntry {
	readonly type: string;
	readonly id: string;
	readonly message?: AgentMessage;
	readonly content?: string | Array<{ type: string; text?: string }>;
}

/** A whole tool result eligible for replacement. */
export interface ToolResultShakeRegion {
	kind: "toolResult";
	entryId: string;
	/** Tool name, used in the placeholder text. */
	label: string;
	tokens: number;
}

/** A fenced/XML span inside one text block eligible for replacement. */
export interface BlockShakeRegion {
	kind: "block";
	entryId: string;
	/** Index into the content array, or {@link STRING_CONTENT} for string-form content. */
	blockIndex: number;
	/** Character offsets into the target text, start inclusive and end exclusive. */
	start: number;
	end: number;
	/** Role or customType, used in the placeholder text. */
	label: string;
	tokens: number;
}

export type ShakeRegion = ToolResultShakeRegion | BlockShakeRegion;

/** `blockIndex` for content stored as a bare string rather than a block array. */
export const STRING_CONTENT = -1;
/** `blockIndex` standing for "the whole tool result", which has no block granularity. */
export const WHOLE_TOOL_RESULT = -2;

/**
 * A durable record of one shaken region, replayed at context-build time.
 *
 * Stores the post-shake text of the *entire* block rather than an offset splice. Offsets are only
 * valid against the text they were computed from, so a second shake over an already-shaken block
 * would depend on replay order to land correctly. A whole-block snapshot is order-independent and
 * idempotent, at the cost of storing text that is small by construction.
 */
export type ShakeRedaction =
	| { kind: "toolResult"; targetId: string; text: string }
	| { kind: "block"; targetId: string; blockIndex: number; text: string };

/** What has already been shaken: entry id to the set of block indices redacted on it. */
export type ShakenIndex = ReadonlyMap<string, ReadonlySet<number>>;

/** Rough token cost of one placeholder line, used only for the savings gate. */
const PLACEHOLDER_TOKEN_ESTIMATE = 16;

const ESTIMATED_IMAGE_CHARS = 4800;

/** Mirrors the character heuristic in `estimateTokens` so both agree on what a region is worth. */
function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") return estimateTextTokens(content);
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return Math.ceil(chars / 4);
}

/** Token weight of an entry for the protect/cache windows. Non-context entries weigh nothing. */
function entryTokens(entry: ShakeCandidateEntry, estimate: (message: AgentMessage) => number): number {
	if (entry.type === "message" && entry.message) return estimate(entry.message);
	if (entry.type === "custom_message" && entry.content !== undefined) return estimateContentTokens(entry.content);
	return 0;
}

function asToolResult(entry: ShakeCandidateEntry): ToolResultMessage | undefined {
	if (entry.type !== "message" || !entry.message) return undefined;
	if (entry.message.role !== "toolResult") return undefined;
	return entry.message as ToolResultMessage;
}

function isProtectedToolResult(message: ToolResultMessage, matchers: ProtectedToolMatcher[]): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (message.toolName === matcher) return true;
		} else if (matcher(message)) {
			return true;
		}
	}
	return false;
}

// Lowercase tag names only — conservative by design, mixed-case tags are ignored.
const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

/**
 * Locate fenced code blocks and top-level XML element spans in `text`, as `[start, end)` character
 * ranges covering the opening and closing lines but not the trailing newline.
 *
 * Conservative: an unterminated fence or tag yields no range, and XML is not recognized inside a
 * fence. Both keep shake from splicing across a boundary it misread.
 */
function scanTextForBlockRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let inFence = false;
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;
	let lineStart = 0;

	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		const lineEnd = i;
		const trimmedStart = line.trimStart();

		if (trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~")) {
			if (inFence) {
				inFence = false;
				ranges.push({ start: fenceStart, end: lineEnd });
				fenceStart = -1;
			} else {
				inFence = true;
				fenceStart = lineStart;
			}
			lineStart = i + 1;
			continue;
		}

		if (!inFence) {
			// Only a line that is exactly a tag counts; indented or inline tags are left alone.
			const isOpening = line.length === trimmedStart.length && OPENING_XML.test(trimmedStart);
			if (isOpening) {
				const match = OPENING_XML.exec(trimmedStart);
				if (match) {
					if (tagStack.length === 0) xmlStart = lineStart;
					tagStack.push(match[1]);
				}
			} else {
				const closing = CLOSING_XML.exec(trimmedStart);
				if (closing && tagStack.length > 0 && tagStack[tagStack.length - 1] === closing[1]) {
					tagStack.pop();
					if (tagStack.length === 0 && xmlStart >= 0) {
						ranges.push({ start: xmlStart, end: lineEnd });
						xmlStart = -1;
					}
				}
			}
		}

		lineStart = i + 1;
	}

	return mergeRanges(ranges);
}

/**
 * Sort ascending and drop any range overlapping one already kept. Fence and XML spans are properly
 * nested (XML is suppressed inside fences), so an overlap means containment and keeping the
 * earlier start keeps the outermost span.
 */
function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	if (ranges.length <= 1) return ranges;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const kept: Array<{ start: number; end: number }> = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

function collectBlockRegions(
	entry: ShakeCandidateEntry,
	blockIndex: number,
	text: string,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	for (const range of scanTextForBlockRanges(text)) {
		const slice = text.slice(range.start, range.end);
		if (slice.length === 0) continue;
		const tokens = estimateTextTokens(slice);
		if (tokens < config.fenceMinTokens) continue;
		out.push({ kind: "block", entryId: entry.id, blockIndex, start: range.start, end: range.end, label, tokens });
	}
}

function scanContentBlocks(
	entry: ShakeCandidateEntry,
	content: string | Array<{ type: string; text?: string }>,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	if (typeof content === "string") {
		collectBlockRegions(entry, STRING_CONTENT, content, config, label, out);
		return;
	}
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block.type === "text" && typeof block.text === "string") {
			collectBlockRegions(entry, i, block.text, config, label, out);
		}
	}
}

/**
 * Collect the eligible block regions of a non-tool-result entry.
 *
 * `toolCall` blocks are never scanned: their arguments pair with a tool result, and rewriting one
 * half of that pair is how providers get a malformed conversation.
 */
function collectEntryBlockRegions(entry: ShakeCandidateEntry, config: ShakeConfig, out: ShakeRegion[]): void {
	if (entry.type === "custom_message") {
		if (entry.content !== undefined) scanContentBlocks(entry, entry.content, config, "custom", out);
		return;
	}
	if (entry.type !== "message" || !entry.message) return;
	const message = entry.message;
	if (message.role === "assistant") {
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i];
			if (block.type === "text") collectBlockRegions(entry, i, block.text, config, "assistant", out);
		}
		return;
	}
	if (message.role === "user") {
		scanContentBlocks(entry, message.content as string | Array<{ type: string; text?: string }>, config, "user", out);
	}
}

/**
 * Pure detection: every region on this branch that shake may replace, in document order.
 *
 * Walks the two windows described on {@link ShakeConfig} plus the compaction boundary, skips
 * protected and already-shaken targets, and returns `[]` when the combined savings would not reach
 * `minSavings` — a shake that frees little is not worth the cache invalidation it causes.
 */
export function collectShakeRegions(
	entries: readonly ShakeCandidateEntry[],
	config: ShakeConfig,
	alreadyShaken: ShakenIndex,
	estimate: (message: AgentMessage) => number,
): ShakeRegion[] {
	const n = entries.length;
	if (n === 0) return [];

	// Tokens of every entry strictly more recent than i.
	const tokensAfter = new Array<number>(n);
	let accumulated = 0;
	for (let i = n - 1; i >= 0; i--) {
		tokensAfter[i] = accumulated;
		accumulated += entryTokens(entries[i], estimate);
	}

	const boundaryIndex =
		config.keepBoundaryId === undefined
			? 0
			: Math.max(
					0,
					entries.findIndex((entry) => entry.id === config.keepBoundaryId),
				);

	const regions: ShakeRegion[] = [];
	for (let i = boundaryIndex; i < n; i++) {
		const entry = entries[i];
		// Too recent: the agent is still working from it.
		if (tokensAfter[i] < config.protectTokens) continue;
		// Too deep: it sits in the provider's warm cache prefix (see cacheWarmSuffixTokens).
		if (config.cacheWarmSuffixTokens !== undefined && tokensAfter[i] > config.cacheWarmSuffixTokens) continue;

		const shakenBlocks = alreadyShaken.get(entry.id);
		const toolResult = asToolResult(entry);
		if (toolResult) {
			if (shakenBlocks?.has(WHOLE_TOOL_RESULT)) continue;
			if (isProtectedToolResult(toolResult, config.protectedTools)) continue;
			const tokens = estimate(toolResult as AgentMessage);
			if (tokens <= PLACEHOLDER_TOKEN_ESTIMATE) continue;
			regions.push({ kind: "toolResult", entryId: entry.id, label: toolResult.toolName, tokens });
			continue;
		}

		const before = regions.length;
		collectEntryBlockRegions(entry, config, regions);
		if (shakenBlocks && regions.length > before) {
			// Drop regions on blocks a previous shake already rewrote.
			const kept = regions
				.slice(before)
				.filter((region) => region.kind !== "block" || !shakenBlocks.has(region.blockIndex));
			regions.length = before;
			regions.push(...kept);
		}
	}

	let savings = 0;
	for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE);
	if (savings < config.minSavings) return [];

	return regions;
}

/** Human-readable token size for placeholder text. */
function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

/**
 * Placeholder left behind by a shaken region.
 *
 * Identifies saved session text only when the host exposes authorized history readback.
 */
export function formatShakePlaceholder(region: ShakeRegion, historyAvailable = false): string {
	const size = formatTokens(region.tokens);
	const source = `entryId=${region.entryId}${region.kind === "block" ? ` blockIndex=${region.blockIndex}` : ""}`;
	const readable =
		historyAvailable &&
		!(
			region.kind === "toolResult" &&
			["memory_get", "memory_search", "history", "context_note"].includes(region.label)
		);
	return `[shaken: ${size} tokens of \`${region.label}\` removed from working context; ${source}. ${readable ? "Use history operation=read_item to read the saved text; multiple text blocks require blockIndex." : "History readback is unavailable for this source."}]`;
}

/** Content of the entry's message, for the roles that have one. `bashExecution` carries none. */
function messageContent(message: AgentMessage): string | Array<{ type: string; text?: string }> | undefined {
	if (message.role === "bashExecution" || message.role === "branchSummary" || message.role === "compactionSummary") {
		return undefined;
	}
	return message.content as string | Array<{ type: string; text?: string }>;
}

function readBlockText(entry: ShakeCandidateEntry, blockIndex: number): string | undefined {
	const content =
		entry.type === "custom_message" ? entry.content : entry.message ? messageContent(entry.message) : undefined;
	if (content === undefined) return undefined;
	if (blockIndex === STRING_CONTENT) return typeof content === "string" ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	const block = content[blockIndex] as { type: string; text?: string } | undefined;
	return block?.type === "text" ? block.text : undefined;
}

/**
 * Turn regions into durable redactions.
 *
 * Block regions sharing one text block are spliced highest-start-first so an earlier replacement
 * never shifts a later region's offsets, then the whole resulting block text is emitted as one
 * redaction. Reads `entries` but never mutates them.
 */
export function buildRedactions(
	entries: readonly ShakeCandidateEntry[],
	regions: readonly ShakeRegion[],
	historyAvailable = false,
): ShakeRedaction[] {
	const byId = new Map<string, ShakeCandidateEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	const redactions: ShakeRedaction[] = [];
	/** Block regions grouped by `entryId\u0000blockIndex` so co-located splices batch together. */
	const blockGroups = new Map<string, BlockShakeRegion[]>();

	for (const region of regions) {
		if (region.kind === "toolResult") {
			const message = byId.get(region.entryId)?.message;
			const hasText = message?.role === "toolResult" && message.content.some((block) => block.type === "text");
			redactions.push({
				kind: "toolResult",
				targetId: region.entryId,
				text: formatShakePlaceholder(region, historyAvailable && hasText),
			});
			continue;
		}
		const key = `${region.entryId}\u0000${region.blockIndex}`;
		const group = blockGroups.get(key);
		if (group) {
			group.push(region);
		} else {
			blockGroups.set(key, [region]);
		}
	}

	for (const group of blockGroups.values()) {
		const first = group[0];
		const entry = byId.get(first.entryId);
		if (!entry) continue;
		const original = readBlockText(entry, first.blockIndex);
		if (original === undefined) continue;

		let text = original;
		for (const region of [...group].sort((a, b) => b.start - a.start)) {
			text = text.slice(0, region.start) + formatShakePlaceholder(region, historyAvailable) + text.slice(region.end);
		}
		redactions.push({ kind: "block", targetId: first.entryId, blockIndex: first.blockIndex, text });
	}

	return redactions;
}

/** Estimated tokens freed by a redaction set, for reporting. */
export function estimateShakeSavings(regions: readonly ShakeRegion[]): number {
	let savings = 0;
	for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE);
	return savings;
}

/** Fold redaction lists into a {@link ShakenIndex} for the next detection pass. */
export function buildShakenIndex(redactions: readonly ShakeRedaction[]): ShakenIndex {
	const index = new Map<string, Set<number>>();
	for (const redaction of redactions) {
		const blockIndex = redaction.kind === "toolResult" ? WHOLE_TOOL_RESULT : redaction.blockIndex;
		const existing = index.get(redaction.targetId);
		if (existing) {
			existing.add(blockIndex);
		} else {
			index.set(redaction.targetId, new Set([blockIndex]));
		}
	}
	return index;
}

function withBlockText<T extends { type: string; text?: string }>(blocks: T[], blockIndex: number, text: string): T[] {
	return blocks.map((block, i) => (i === blockIndex ? { ...block, text } : block));
}

/**
 * Replay redactions over a context entry list, returning a list where every affected entry is a
 * shallow copy carrying the redacted content.
 *
 * Copies rather than mutates because the input entries are the stored session objects, shared with
 * the session's id index and tree; editing them in place would corrupt both and make the redaction
 * unrepeatable. Unaffected entries keep their original reference.
 *
 * Redactions are applied in list order, so a later redaction of the same target wins — which is
 * what makes replaying an accumulated log idempotent.
 */
export function applyRedactions<T extends ShakeCandidateEntry>(
	entries: readonly T[],
	redactions: readonly ShakeRedaction[],
): T[] {
	if (redactions.length === 0) return entries.slice();

	const result = entries.slice();
	const indexById = new Map<string, number>();
	for (let i = 0; i < result.length; i++) indexById.set(result[i].id, i);

	for (const redaction of redactions) {
		const at = indexById.get(redaction.targetId);
		if (at === undefined) continue;
		const entry = result[at];

		if (redaction.kind === "toolResult") {
			if (entry.type !== "message" || !entry.message || entry.message.role !== "toolResult") continue;
			const message: ToolResultMessage = {
				...(entry.message as ToolResultMessage),
				content: [{ type: "text", text: redaction.text } as TextContent],
			};
			result[at] = { ...entry, message };
			continue;
		}

		if (entry.type === "custom_message") {
			const content = entry.content;
			if (content === undefined) continue;
			if (redaction.blockIndex === STRING_CONTENT) {
				if (typeof content !== "string") continue;
				result[at] = { ...entry, content: redaction.text };
			} else {
				if (!Array.isArray(content)) continue;
				result[at] = { ...entry, content: withBlockText(content, redaction.blockIndex, redaction.text) };
			}
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message as { content: unknown };
		if (redaction.blockIndex === STRING_CONTENT) {
			if (typeof message.content !== "string") continue;
			result[at] = { ...entry, message: { ...entry.message, content: redaction.text } as AgentMessage };
		} else {
			if (!Array.isArray(message.content)) continue;
			const blocks = withBlockText(
				message.content as Array<{ type: string; text?: string }>,
				redaction.blockIndex,
				redaction.text,
			);
			result[at] = { ...entry, message: { ...entry.message, content: blocks } as AgentMessage };
		}
	}

	return result;
}
