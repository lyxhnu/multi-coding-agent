import { createHash } from "node:crypto";
import { applyRedactions } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { collectShakeRedactions, type SessionEntry, sessionEntryToContextMessages } from "../session-manager.ts";
import type { CompactionPreparation } from "./compaction.ts";

export interface PrefixSummaryCheckpoint {
	baseCompactionId: string | null;
	coveredStartEntryId: string;
	coveredEndEntryId: string;
	sourceFingerprint: string;
	summary: string;
	usage?: Usage;
}

function prefixSource(entries: SessionEntry[], endId: string) {
	const effective = applyRedactions(entries, collectShakeRedactions(entries));
	const base = [...effective].reverse().find((entry) => entry.type === "compaction");
	const start = base ? effective.findIndex((entry) => entry.id === base.firstKeptEntryId) : 0;
	const end = effective.findIndex((entry) => entry.id === endId);
	if (start < 0 || end < start) return undefined;
	const covered = effective
		.slice(start, end + 1)
		.filter((entry) => entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0);
	if (!covered.length) return undefined;
	return {
		baseCompactionId: base?.id ?? null,
		coveredStartEntryId: covered[0].id,
		coveredEndEntryId: covered[covered.length - 1].id,
		sourceFingerprint: createHash("sha256")
			.update(
				JSON.stringify({
					base: base?.summary,
					entries: covered.map((entry) => ({ id: entry.id, messages: sessionEntryToContextMessages(entry) })),
				}),
			)
			.digest("hex"),
		count: covered.length,
	};
}

export function createPrefixCheckpoint(
	entries: SessionEntry[],
	preparation: CompactionPreparation,
	summary: string,
	usage?: Usage,
): PrefixSummaryCheckpoint {
	const cut = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	const end = entries
		.slice(0, cut)
		.reverse()
		.find((entry) => entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0);
	const source = end && prefixSource(entries, end.id);
	if (!source || !summary.trim()) throw new Error("Invalid prefix checkpoint source");
	const { count: _count, ...identity } = source;
	return { ...identity, summary, usage };
}

export function isPrefixCheckpoint(value: unknown): value is PrefixSummaryCheckpoint {
	if (typeof value !== "object" || value === null) return false;
	const checkpoint = value as Partial<PrefixSummaryCheckpoint>;
	return (
		(checkpoint.baseCompactionId === null || typeof checkpoint.baseCompactionId === "string") &&
		typeof checkpoint.coveredStartEntryId === "string" &&
		typeof checkpoint.coveredEndEntryId === "string" &&
		typeof checkpoint.sourceFingerprint === "string" &&
		typeof checkpoint.summary === "string" &&
		checkpoint.summary.trim().length > 0 &&
		(checkpoint.usage === undefined || isCheckpointUsage(checkpoint.usage))
	);
}

export function isCheckpointUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Partial<Usage>;
	return [
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
		usage.cost?.input,
		usage.cost?.output,
		usage.cost?.cacheRead,
		usage.cost?.cacheWrite,
		usage.cost?.total,
	].every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0);
}

export function validatePrefixCheckpoint(entries: SessionEntry[], checkpoint: PrefixSummaryCheckpoint): boolean {
	const source = prefixSource(entries, checkpoint.coveredEndEntryId);
	return (
		source !== undefined &&
		source.baseCompactionId === checkpoint.baseCompactionId &&
		source.coveredStartEntryId === checkpoint.coveredStartEntryId &&
		source.coveredEndEntryId === checkpoint.coveredEndEntryId &&
		source.sourceFingerprint === checkpoint.sourceFingerprint
	);
}

export function reusePrefixCheckpoint(
	entries: SessionEntry[],
	preparation: CompactionPreparation,
	checkpoint: PrefixSummaryCheckpoint,
): CompactionPreparation | undefined {
	if (!validatePrefixCheckpoint(entries, checkpoint)) return undefined;
	const cut = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	const end = entries.findIndex((entry) => entry.id === checkpoint.coveredEndEntryId);
	if (end >= cut) return undefined;
	const source = prefixSource(entries, checkpoint.coveredEndEntryId)!;
	const historyCount = preparation.messagesToSummarize.length;
	return {
		...preparation,
		previousSummary: checkpoint.summary,
		prefixUsage: checkpoint.usage,
		messagesToSummarize: preparation.messagesToSummarize.slice(source.count),
		turnPrefixMessages: preparation.turnPrefixMessages.slice(Math.max(0, source.count - historyCount)),
	};
}
