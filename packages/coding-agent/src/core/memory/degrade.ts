/**
 * Three-tier structural degradation for session notes (OMP mnemopi's degradeEpisodic adapted to
 * markdown files): aging notes lose detail but never disappear. Tier 1 is the full note, tier 2
 * keeps the first NOTE_TIER2_MAX_CHARS, tier 3 keeps only key signal (heading and list lines).
 * Curated MEMORY.md blocks are never degraded — they are the human-editable canon, and autoDream
 * already distills notes into them. Degradation is lossy by design; the full originals survive only
 * in the session JSONL transcripts.
 */

export const NOTE_TIER2_AFTER_DAYS = 30;
export const NOTE_TIER3_AFTER_DAYS = 180;
export const NOTE_TIER2_MAX_CHARS = 800;
export const NOTE_TIER3_MAX_CHARS = 300;
/** Search-side downweight per tier: the more degraded a note, the later it ranks. */
export const TIER_WEIGHTS = { 1: 1, 2: 0.85, 3: 0.7 } as const;

export type NoteTier = 1 | 2 | 3;

/** First-line marker written on degradation. Plain HTML comment: human-readable and hand-editable. */
const TIER_MARKER = /^<!--\s*memory-tier:([23])\s+degraded:[^>]*-->\n?/;

export function parseTierMarker(content: string): { tier: NoteTier; body: string } {
	const match = TIER_MARKER.exec(content);
	if (!match) return { tier: 1, body: content };
	return { tier: Number(match[1]) as NoteTier, body: content.slice(match[0].length) };
}

/**
 * Keeps heading (`#`) and list (`-`, `*`, `1.`) lines, in order, until the budget is spent — the
 * lines that survive a note's own structure. Falls back to a plain prefix cut (with an ellipsis)
 * for unstructured text.
 */
export function extractKeySignal(content: string, maxChars: number): string {
	const signal: string[] = [];
	let used = 0;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!/^(#{1,6}\s|[-*]\s|\d+[.)]\s)/.test(trimmed)) continue;
		if (used + trimmed.length + 1 > maxChars) break;
		signal.push(trimmed);
		used += trimmed.length + 1;
	}
	if (signal.length > 0) return signal.join("\n");
	const flat = content.trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/**
 * Full replacement file content when the note's age crosses a tier boundary it has not reached yet,
 * or undefined when nothing needs rewriting. Idempotent: the tier only ever increases, so a second
 * pass over an already-degraded note is a no-op until the next boundary.
 */
export function degradeNoteContent(content: string, ageDays: number, now: Date): string | undefined {
	const { tier, body } = parseTierMarker(content);
	const target: NoteTier = ageDays >= NOTE_TIER3_AFTER_DAYS ? 3 : ageDays >= NOTE_TIER2_AFTER_DAYS ? 2 : 1;
	if (target <= tier) return undefined;
	const marker = `<!-- memory-tier:${target} degraded:${now.toISOString()} -->\n`;
	if (target === 2) {
		const kept = body.length > NOTE_TIER2_MAX_CHARS ? `${body.slice(0, NOTE_TIER2_MAX_CHARS - 1)}…` : body;
		return marker + kept;
	}
	return marker + extractKeySignal(body, NOTE_TIER3_MAX_CHARS);
}
