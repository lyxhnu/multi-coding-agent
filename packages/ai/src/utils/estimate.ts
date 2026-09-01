import type { Api, Context, ImageContent, Message, Model, TextContent, Tool, Usage } from "../types.ts";
import { shortHash } from "./hash.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function contextFingerprint(context: Context, model: Model<Api>): string {
	return shortHash(
		JSON.stringify({
			model: [model.provider, model.id, model.api, model.baseUrl],
			systemPrompt: context.systemPrompt ?? "",
			tools:
				context.tools?.map(({ name, description, parameters, constrainedSampling }) => ({
					name,
					description,
					parameters,
					constrainedSampling,
				})) ?? [],
			messages: context.messages.map((message) => ({
				role: message.role,
				content: message.content,
				...(message.role === "toolResult"
					? {
							toolCallId: message.toolCallId,
							toolName: message.toolName,
							isError: message.isError,
							addedToolNames: message.addedToolNames,
						}
					: {}),
				...(message.role === "assistant"
					? { api: message.api, provider: message.provider, model: message.model }
					: {}),
			})),
		}),
	);
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

export function estimateContextTokens(input: Context | readonly Message[], model?: Model<Api>): ContextUsageEstimate {
	const context: Context = isMessageArray(input) ? { messages: [...input] } : input;
	if (model) {
		for (let i = context.messages.length - 1; i >= 0; i--) {
			const message = context.messages[i];
			if (
				message.role !== "assistant" ||
				message.stopReason === "error" ||
				message.stopReason === "aborted" ||
				!message.usageContextFingerprint ||
				calculateContextTokens(message.usage) <= 0
			)
				continue;
			if (
				message.usageContextFingerprint ===
				contextFingerprint({ ...context, messages: context.messages.slice(0, i + 1) }, model)
			) {
				const usageTokens = calculateContextTokens(message.usage);
				const trailingTokens = context.messages
					.slice(i + 1)
					.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
				return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i };
			}
			break;
		}
	}
	const tokens =
		estimateTextTokens(context.systemPrompt ?? "") +
		estimateToolsTokens(context.tools) +
		context.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

export const CONTEXT_SAFETY_TOKENS = 4096;
export const OUTPUT_HEADROOM_FACTOR = 1.2;
export const OUTPUT_HEADROOM_MAX_TOKENS = 32768;

export interface ContextBudgetOptions {
	outputReserveTokens?: number;
	thresholdPercent?: number;
	reserveTokens?: number;
}

export interface ContextBudget extends ContextUsageEstimate {
	contextWindow: number;
	modelMaxOutputTokens: number | null;
	requestedMaxOutputTokens: number | null;
	unknownFields: Array<"contextWindow" | "maxTokens">;
	outputReserveTokens: number;
	safetyTokens: number;
	availableOutputTokens: number | null;
	decision: "fits" | "context_limit" | "unknown";
}

export function calculateContextBudget(
	model: Model<Api>,
	context: Context,
	options: ContextBudgetOptions = {},
): ContextBudget {
	const estimate = estimateContextTokens(context, model);
	return evaluateContextBudget(estimate, model, options);
}

export function evaluateContextBudget(
	estimate: ContextUsageEstimate,
	model: Pick<Model<Api>, "maxTokens" | "contextWindow">,
	options: ContextBudgetOptions = {},
): ContextBudget {
	const knownMax = Number.isFinite(model.maxTokens) && model.maxTokens > 0;
	const requested = options.outputReserveTokens ?? (knownMax ? model.maxTokens : 0);
	const outputReserveTokens = Math.max(
		0,
		Math.min(
			Number.isFinite(requested) ? requested : 0,
			knownMax ? model.maxTokens : Infinity,
			OUTPUT_HEADROOM_MAX_TOKENS,
		),
	);
	const safetyTokens = Math.max(CONTEXT_SAFETY_TOKENS, Math.ceil(outputReserveTokens * (OUTPUT_HEADROOM_FACTOR - 1)));
	const knownWindow = Number.isFinite(model.contextWindow) && model.contextWindow > 0;
	const availableOutputTokens = knownWindow ? Math.max(0, model.contextWindow - estimate.tokens - safetyTokens) : null;
	const pressure =
		knownWindow &&
		(estimate.tokens + outputReserveTokens + safetyTokens > model.contextWindow ||
			(options.thresholdPercent !== undefined &&
				estimate.tokens >= (model.contextWindow * options.thresholdPercent) / 100) ||
			(options.reserveTokens !== undefined && estimate.tokens > model.contextWindow - options.reserveTokens));
	return {
		...estimate,
		contextWindow: model.contextWindow,
		modelMaxOutputTokens: knownMax ? model.maxTokens : null,
		requestedMaxOutputTokens: options.outputReserveTokens ?? null,
		unknownFields: [
			...(!knownWindow ? ["contextWindow" as const] : []),
			...(!knownMax ? ["maxTokens" as const] : []),
		],
		outputReserveTokens,
		safetyTokens,
		availableOutputTokens,
		decision: pressure ? "context_limit" : !knownWindow || !knownMax ? "unknown" : "fits",
	};
}
