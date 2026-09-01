/**
 * Grok-aligned memory storage layer (spec 10.2): curated global + per-project MEMORY.md files, plus
 * per-project session notes. Storage root is always injected by the caller (never hardcoded to the real
 * `~/.pi/agent/memory` here) so tests can point it at a tmpdir — see config.ts's getMemoryDir() for the
 * production default and agent-session.ts for how it's wired in.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { isPathWithinScope } from "../permissions/path-inspector.ts";
import { degradeNoteContent, type NoteTier, parseTierMarker, TIER_WEIGHTS } from "./degrade.ts";
import { EMBED_MAX_CHARS, type MemoryEmbedder } from "./embeddings.ts";
import { type MemoryExtraction, validateMemoryExtraction } from "./extraction.ts";
import { type IndexableBlock, MemoryVectorIndex, VECTOR_MIN_SIMILARITY } from "./memory-index.ts";
import { type MmrCandidate, mmrRerank } from "./mmr.ts";
import { checkMemoryCandidate } from "./secret-filter.ts";

export type MemoryScope = "global" | "project";

/** sha256(canonical cwd).slice(0, 16) — stable per-project bucket name under the memory root. */
export function workspaceHash(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

export function globalMemoryFile(root: string): string {
	return join(root, "MEMORY.md");
}

export function projectMemoryDir(root: string, cwd: string): string {
	return join(root, workspaceHash(cwd));
}

export function projectMemoryFile(root: string, cwd: string): string {
	return join(projectMemoryDir(root, cwd), "MEMORY.md");
}

export function projectSessionsDir(root: string, cwd: string): string {
	return join(projectMemoryDir(root, cwd), "sessions");
}

function tombstoneFile(memoryFile: string): string {
	return `${memoryFile}.tombstones.json`;
}

function readTombstones(memoryFile: string): Set<string> {
	if (!existsSync(tombstoneFile(memoryFile))) return new Set();
	try {
		const raw = readFileSync(tombstoneFile(memoryFile), "utf-8");
		const ids: unknown = JSON.parse(raw);
		if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
			throw new Error("Invalid tombstones");
		}
		return new Set(ids);
	} catch {
		throw new Error("Invalid memory revocation state");
	}
}

function addTombstone(memoryFile: string, id: string): void {
	const release = lockfile.lockSync(memoryFile, { realpath: false });
	try {
		const set = readTombstones(memoryFile);
		set.add(id);
		writeAtomic(tombstoneFile(memoryFile), JSON.stringify([...set]));
	} finally {
		release();
	}
}

function writeAtomic(path: string, content: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export interface MemoryBlock {
	id: string;
	heading: string;
	body: string;
}

/** Parses a MEMORY.md file's `<!-- id:... -->` delimited blocks (see appendEntry). */
function parseBlocks(content: string): MemoryBlock[] {
	const blocks: MemoryBlock[] = [];
	const marker = /<!--\s*id:([a-zA-Z0-9_-]+)\s*-->\r?\n?/g;
	const matches = [...content.matchAll(marker)];
	const preamble = content.slice(0, matches[0]?.index ?? content.length).trim();
	if (preamble)
		blocks.push({
			id: "",
			heading: preamble.match(/^#{1,6}\s*(.+)$/m)?.[1]?.trim() ?? preamble.slice(0, 60),
			body: preamble,
		});
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const start = match.index! + match[0].length;
		const end = i + 1 < matches.length ? matches[i + 1]!.index! : content.length;
		const block = content.slice(start, end).trim();
		const headingMatch = block.match(/^#{1,6}\s*(.+)$/m);
		blocks.push({ id: match[1]!, heading: headingMatch?.[1]?.trim() ?? block.slice(0, 60), body: block });
	}
	return blocks;
}

export interface AppendResult {
	written: number;
	skipped: number;
	warning?: string;
	ids: string[];
	reasons: string[];
}

/** Appends one or more candidate notes to `memoryFile` after running them through the secret filter. */
function appendEntries(memoryFile: string, headingPrefix: string, candidates: string[]): AppendResult {
	const dir = dirname(memoryFile);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const ids: string[] = [];
	const reasons: string[] = [];
	let skipped = 0;
	let appended = "";
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (!trimmed) {
			skipped++;
			reasons.push("empty");
			continue;
		}
		const verdict = checkMemoryCandidate(trimmed);
		if (!verdict.safe) {
			skipped++;
			reasons.push(verdict.reason!);
			continue;
		}
		const id = `mem-${randomUUID().slice(0, 8)}`;
		ids.push(id);
		const timestamp = new Date().toISOString();
		appended += `\n<!-- id:${id} -->\n## ${headingPrefix} ${timestamp}\n\n${trimmed}\n`;
	}
	if (appended) {
		const release = lockfile.lockSync(memoryFile, { realpath: false });
		try {
			writeAtomic(memoryFile, (existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "") + appended);
		} finally {
			release();
		}
	}
	return {
		written: ids.length,
		skipped,
		warning: skipped > 0 ? `${skipped} candidate(s) were discarded by the secret filter` : undefined,
		ids,
		reasons,
	};
}

export interface MemorySearchHit {
	path: string;
	heading: string;
	snippet: string;
	score: number;
}

/** One searchable unit during a search pass: a curated block, a session note, or a whole file. */
interface SearchCandidateBlock {
	id: string;
	path: string;
	key: string;
	fileScope: MemoryScope;
	relative: string;
	heading: string;
	body: string;
	/** Heading + body: what gets embedded and what MMR compares. */
	text: string;
	termScore: number;
	/** recencyFactor × tier weight, applied to the fused relevance. */
	decayFactor: number;
	cosine: number;
}

function scoreBlock(query: string, block: MemoryBlock): number {
	const q = query.toLowerCase();
	const haystack = `${block.heading}\n${block.body}`.toLowerCase();
	if (!q.trim()) return 0;
	const terms = q.split(/\s+/).filter(Boolean);
	let score = 0;
	for (const term of terms) {
		let index = haystack.indexOf(term);
		while (index !== -1) {
			score += 1;
			index = haystack.indexOf(term, index + term.length);
		}
	}
	return score;
}

function snippetAround(body: string, query: string, maxLen = 240): string {
	const idx = body.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0] ?? "");
	const start = idx > 40 ? idx - 40 : 0;
	const slice = body.slice(start, start + maxLen).trim();
	return slice.length < body.length ? `${slice}…` : slice;
}

// ---------------------------------------------------------------------------
// Ranking: recency decay + MMR rerank (ported from OMP mnemopi's recall path)
// ---------------------------------------------------------------------------

/** Decay floor: an old memory keeps at least 70% of its term score, so age is a tiebreaker, never a veto. */
export const RECENCY_FLOOR = 0.7;
/** Half-life for curated MEMORY.md blocks (global + project, incl. autoDream consolidations): 90 days. */
export const CURATED_HALF_LIFE_HOURS = 2160;
/** Half-life for raw session notes: 14 days — autoDream moves their durable value into curated blocks. */
export const SESSION_NOTE_HALF_LIFE_HOURS = 336;
/** MMR balance: 70% relevance, 30% penalty for similarity to already-selected results. */
export const MMR_LAMBDA = 0.7;
/** Cap on how many top-scored candidates enter the MMR rerank. */
export const MMR_POOL_CAP = 50;
/** Fusion weights when the vector channel is active: semantics lead, keywords anchor. */
export const VECTOR_WEIGHT = 0.6;
export const KEYWORD_WEIGHT = 0.4;

const HEADING_ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
const NOTE_FILE_DATE = /^(\d{4}-\d{2}-\d{2})-/;

/**
 * Best-effort timestamp for a search candidate: the ISO timestamp appendEntries puts in the block
 * heading, else the YYYY-MM-DD prefix writeSessionNote puts in the file name, else the file's mtime
 * (hand-edited files without either land here).
 */
function candidateTimestamp(heading: string, filePath: string): Date {
	const headingMatch = HEADING_ISO_TIMESTAMP.exec(heading);
	if (headingMatch) {
		const parsed = new Date(headingMatch[0]);
		if (Number.isFinite(parsed.getTime())) return parsed;
	}
	const nameMatch = NOTE_FILE_DATE.exec(basename(filePath));
	if (nameMatch) {
		const parsed = new Date(nameMatch[1]!);
		if (Number.isFinite(parsed.getTime())) return parsed;
	}
	try {
		return statSync(filePath).mtime;
	} catch {
		return new Date();
	}
}

/** `floor + (1 - floor) * exp(-age/halfLife)`. A future timestamp (clock skew) counts as age 0. */
function recencyFactor(timestamp: Date, halfLifeHours: number): number {
	const ageHours = Math.max(0, (Date.now() - timestamp.getTime()) / 3_600_000);
	return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-ageHours / halfLifeHours);
}

/** Decayed scores are floats; three decimals keeps the tool output readable. */
function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// autoDream (spec 10.5): consolidation state + lock
// ---------------------------------------------------------------------------

interface DreamState {
	lastConsolidatedAt: number;
	processed: Record<string, string>;
}

interface NoteMetadata {
	id: string;
	sessionId: string;
	compactionId: string;
	contentHash: string;
	storedHash: string;
}

export interface NoteSnapshot extends NoteMetadata {
	path: string;
	content: string;
}

interface DreamCommit {
	batchId: string;
	sources: Array<{ id: string; hash: string; viewHash: string }>;
	extraction: MemoryExtraction;
	createdAt: number;
}

function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function parseNote(content: string): { metadata?: NoteMetadata; body: string } {
	const match = /^<!-- memory-note:(.+) -->\r?\n/.exec(content);
	if (!match) return { body: content };
	let metadata: unknown;
	try {
		metadata = JSON.parse(match[1]!);
	} catch {
		throw new Error("Invalid memory note metadata");
	}
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!["id", "sessionId", "compactionId", "contentHash", "storedHash"].every(
			(key) => typeof (metadata as Record<string, unknown>)[key] === "string",
		)
	) {
		throw new Error("Invalid memory note metadata");
	}
	return { metadata: metadata as NoteMetadata, body: content.slice(match[0].length) };
}

function serializeNote(metadata: NoteMetadata, body: string): string {
	return `<!-- memory-note:${JSON.stringify(metadata)} -->\n${body}`;
}

function readDreamState(statePath: string): DreamState {
	if (!existsSync(statePath)) return { lastConsolidatedAt: 0, processed: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		throw new Error("Invalid memory consolidation state");
	}
	if (
		!raw ||
		typeof raw !== "object" ||
		!("lastConsolidatedAt" in raw) ||
		typeof raw.lastConsolidatedAt !== "number" ||
		!("processed" in raw) ||
		!raw.processed ||
		typeof raw.processed !== "object" ||
		!Object.values(raw.processed).every((hash) => typeof hash === "string")
	) {
		throw new Error("Invalid memory consolidation state");
	}
	return raw as DreamState;
}

function acquireDreamLock(lockPath: string, onCompromised?: () => void): (() => void) | undefined {
	mkdirSync(dirname(lockPath), { recursive: true });
	try {
		return lockfile.lockSync(lockPath, { realpath: false, lockfilePath: lockPath, stale: 600000, onCompromised });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
		throw error;
	}
}

export interface ConsolidateOptions {
	cwd: string;
	minIntervalMs?: number;
	minNewSessions?: number;
	signal?: AbortSignal;
	/** Tests can use a pure extractor; model-backed callers must supply a budget predicate. */
	inputFits?: (notes: NoteSnapshot[]) => boolean;
	summarize: (sessionNotes: NoteSnapshot[], signal: AbortSignal) => Promise<MemoryExtraction> | MemoryExtraction;
}

export interface ConsolidationResult {
	ran: boolean;
	reason: string;
	written?: number;
	batchId?: string;
	sourceNoteIds?: string[];
}

/**
 * Storage + search primitives for the memory system. Every method is scoped to `root` (see
 * getMemoryDir()); memory_get additionally re-validates containment via path-inspector.ts before
 * returning content, so a caller-supplied path can never escape the memory root.
 */
export class MemoryStore {
	private readonly root: string;
	private readonly embedder: MemoryEmbedder | undefined;

	constructor(root: string, embedder?: MemoryEmbedder) {
		this.root = resolve(root);
		this.embedder = embedder;
	}

	get rootDir(): string {
		return this.root;
	}

	appendGlobal(candidates: string[]): AppendResult {
		return appendEntries(globalMemoryFile(this.root), "Global memory —", candidates);
	}

	appendProject(cwd: string, candidates: string[]): AppendResult {
		return appendEntries(projectMemoryFile(this.root, cwd), "Project memory —", candidates);
	}

	writeSessionNote(
		cwd: string,
		slug: string,
		sessionId: string,
		content: string,
		compactionId: string,
	): AppendResult & { path?: string } {
		const verdict = checkMemoryCandidate(content);
		if (!content.trim() || !verdict.safe) {
			return {
				written: 0,
				skipped: 1,
				ids: [],
				reasons: [verdict.reason ?? "empty"],
				warning: "Session note rejected",
			};
		}
		const dir = projectSessionsDir(this.root, cwd);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const date = new Date().toISOString().slice(0, 10);
		const safeSlug =
			slug
				.toLowerCase()
				.replace(/[^a-z0-9-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "session";
		if (!sessionId || !compactionId) throw new Error("Session notes require a committed compaction source");
		const id = `note-${createHash("sha256").update(`${sessionId}:${compactionId}`).digest("hex").slice(0, 16)}`;
		const release = lockfile.lockSync(join(dir, id), { realpath: false });
		try {
			const fileName = readdirSync(dir).find((name) => name.endsWith(`-${id}.md`)) ?? `${date}-${safeSlug}-${id}.md`;
			const filePath = join(dir, fileName);
			if (!isPathWithinScope(filePath, this.root, this.root)) throw new Error("Memory path outside scope");
			const hash = hashContent(content);
			if (existsSync(filePath)) {
				const existing = parseNote(readFileSync(filePath, "utf8"));
				if (
					existing.metadata?.id !== id ||
					existing.metadata.sessionId !== sessionId ||
					existing.metadata.compactionId !== compactionId ||
					existing.metadata.contentHash !== hash ||
					existing.metadata.storedHash !== hashContent(existing.body)
				)
					throw new Error("Conflicting memory snapshot");
			} else {
				writeFileSync(
					filePath,
					serializeNote({ id, sessionId, compactionId, contentHash: hash, storedHash: hash }, content),
					{ encoding: "utf8", flag: "wx" },
				);
			}
			return {
				written: 1,
				skipped: 0,
				ids: [id],
				reasons: [],
				path: join(workspaceHash(cwd), "sessions", fileName),
			};
		} finally {
			release();
		}
	}

	/** The single read boundary for tools, retrieval, indexing and consolidation. */
	private validBlocks(path: string): MemoryBlock[] {
		if (!isPathWithinScope(path, this.root, this.root)) throw new Error("Memory path outside scope");
		if (!existsSync(path)) return [];
		const tombstones = readTombstones(path);
		return parseBlocks(parseTierMarker(parseNote(readFileSync(path, "utf-8")).body).body).filter(
			(block) => !tombstones.has(block.id) && checkMemoryCandidate(block.body).safe,
		);
	}

	private isCurrentCandidate(block: SearchCandidateBlock): boolean {
		return this.validBlocks(block.path).some((current) => current.id === block.id && current.body === block.body);
	}

	/** Undoes a previously written entry by id (global or a project's MEMORY.md). Tombstones, never deletes. */
	undo(scope: MemoryScope, cwdIfProject: string | undefined, id: string): boolean {
		const memoryFile = scope === "global" ? globalMemoryFile(this.root) : projectMemoryFile(this.root, cwdIfProject!);
		if (!existsSync(memoryFile)) return false;
		const blocks = parseBlocks(readFileSync(memoryFile, "utf-8"));
		if (!blocks.some((b) => b.id === id)) return false;
		addTombstone(memoryFile, id);
		return true;
	}

	/**
	 * Three-tier structural degradation for this project's session notes (see degrade.ts): notes past
	 * NOTE_TIER2_AFTER_DAYS are truncated, past NOTE_TIER3_AFTER_DAYS reduced to key signal, and search
	 * downweights them by tier. Age comes from the file-name date — a rewrite refreshes mtime, so the
	 * name is the only stable anchor — and notes without one are never degraded. Guarded by the same
	 * lock as autoDream so two sessions can't rewrite concurrently. Curated MEMORY.md is never touched.
	 */
	degradeSessionNotes(cwd: string): { degraded: number } {
		const sessionsDir = projectSessionsDir(this.root, cwd);
		if (!existsSync(sessionsDir)) return { degraded: 0 };
		const lockPath = join(projectMemoryDir(this.root, cwd), ".dream.lock");
		const release = acquireDreamLock(lockPath);
		if (!release) return { degraded: 0 };
		try {
			const state = readDreamState(join(projectMemoryDir(this.root, cwd), ".dream-state.json"));
			let degraded = 0;
			const now = new Date();
			for (const name of readdirSync(sessionsDir)) {
				if (!name.endsWith(".md")) continue;
				const dateMatch = NOTE_FILE_DATE.exec(name);
				if (!dateMatch) continue;
				const noteDate = new Date(dateMatch[1]!);
				if (!Number.isFinite(noteDate.getTime())) continue;
				const ageDays = (now.getTime() - noteDate.getTime()) / 86_400_000;
				const filePath = join(sessionsDir, name);
				if (!isPathWithinScope(filePath, this.root, this.root)) throw new Error("Memory path outside scope");
				const { metadata, body } = parseNote(readFileSync(filePath, "utf-8"));
				if (!metadata) continue;
				const actualHash = hashContent(body);
				const processedHash = state.processed[metadata.id];
				if (
					processedHash !== actualHash &&
					!(processedHash === metadata.contentHash && actualHash === metadata.storedHash)
				)
					continue;
				const rewritten = degradeNoteContent(body, ageDays, now);
				if (rewritten !== undefined) {
					writeAtomic(
						filePath,
						serializeNote(
							{ ...metadata, contentHash: processedHash, storedHash: hashContent(rewritten) },
							rewritten,
						),
					);
					degraded++;
				}
			}
			return { degraded };
		} finally {
			release();
		}
	}

	private candidateFiles(
		scope: "global" | "project" | "all",
		cwd: string,
	): { scope: MemoryScope; path: string; relative: string; kind: "curated" | "note" }[] {
		const files: { scope: MemoryScope; path: string; relative: string; kind: "curated" | "note" }[] = [];
		if (scope === "global" || scope === "all") {
			const file = globalMemoryFile(this.root);
			if (existsSync(file)) files.push({ scope: "global", path: file, relative: "MEMORY.md", kind: "curated" });
		}
		if (scope === "project" || scope === "all") {
			const file = projectMemoryFile(this.root, cwd);
			if (existsSync(file))
				files.push({
					scope: "project",
					path: file,
					relative: join(workspaceHash(cwd), "MEMORY.md"),
					kind: "curated",
				});
			const sessions = projectSessionsDir(this.root, cwd);
			if (existsSync(sessions)) {
				for (const name of readdirSync(sessions)) {
					if (!name.endsWith(".md")) continue;
					files.push({
						scope: "project",
						path: join(sessions, name),
						relative: join(workspaceHash(cwd), "sessions", name),
						kind: "note",
					});
				}
			}
		}
		return files;
	}

	/**
	 * Memory search: keyword term scoring plus (when an embedder is configured) vector similarity,
	 * fused per block, recency-decayed (bounded by RECENCY_FLOOR, per-source half-life), downweighted
	 * by degradation tier, and MMR-reranked so near-duplicate blocks don't crowd out complementary
	 * ones. Without an embedder the ranking is exactly the keyword-only pipeline.
	 */
	async search(
		query: string,
		scope: "global" | "project" | "all",
		cwd: string,
		limit = 10,
	): Promise<MemorySearchHit[]> {
		const blocks: SearchCandidateBlock[] = [];
		for (const file of this.candidateFiles(scope, cwd)) {
			if (!isPathWithinScope(file.path, this.root, this.root)) throw new Error("Memory path outside scope");
			const content = readFileSync(file.path, "utf-8");
			const halfLifeHours = file.kind === "note" ? SESSION_NOTE_HALF_LIFE_HOURS : CURATED_HALF_LIFE_HOURS;
			// Degraded notes carry a first-line tier marker: strip it from the searchable text and
			// downweight the block. Curated files are always tier 1.
			const { tier } = file.kind === "note" ? parseTierMarker(parseNote(content).body) : { tier: 1 as NoteTier };
			const tierWeight = TIER_WEIGHTS[tier];
			const parsed = this.validBlocks(file.path);
			for (const block of parsed) {
				const heading = block.id ? block.heading : file.relative;
				blocks.push({
					id: block.id,
					path: file.path,
					key: `${file.relative}:${block.id}`,
					fileScope: file.scope,
					relative: file.relative,
					heading,
					body: block.body,
					text: block.id ? `${heading}\n${block.body}` : block.body,
					termScore: scoreBlock(query, { ...block, heading }),
					decayFactor: recencyFactor(candidateTimestamp(heading, file.path), halfLifeHours) * tierWeight,
					cosine: 0,
				});
			}
		}

		const vectorActive = await this.applyVectorChannel(query, scope, cwd, blocks);

		let maxTermScore = 0;
		for (const block of blocks) maxTermScore = Math.max(maxTermScore, block.termScore);
		const candidates: MmrCandidate<MemorySearchHit>[] = [];
		for (const block of blocks) {
			if (!this.isCurrentCandidate(block)) continue;
			// A block must be hit by at least one channel to become a candidate.
			if (block.termScore <= 0 && block.cosine < VECTOR_MIN_SIMILARITY) continue;
			const keywordNorm = maxTermScore > 0 ? block.termScore / maxTermScore : 0;
			const fused = vectorActive ? VECTOR_WEIGHT * block.cosine + KEYWORD_WEIGHT * keywordNorm : keywordNorm;
			if (fused <= 0) continue;
			const score = fused * block.decayFactor;
			candidates.push({
				item: {
					path: block.relative,
					heading: block.heading,
					snippet: snippetAround(block.body, query),
					score: round3(score),
				},
				relevance: score,
				text: block.text,
			});
		}
		const topK = Math.max(1, limit);
		candidates.sort((a, b) => b.relevance - a.relevance);
		const pool = candidates.slice(0, Math.min(MMR_POOL_CAP, topK * 3));
		if (pool.length <= 1) return pool.map((candidate) => candidate.item);
		// Normalize relevance to 0..1 so the 0..1 similarity penalty inside MMR actually gets a say.
		const maxRelevance = pool[0]!.relevance;
		for (const candidate of pool) {
			candidate.relevance = maxRelevance > 0 ? candidate.relevance / maxRelevance : 0;
		}
		return mmrRerank(pool, MMR_LAMBDA, topK);
	}

	/**
	 * Vector channel: lazily maintains the per-scope sidecar indexes (within the per-search embedding
	 * budget), embeds the query, and writes each block's cosine similarity into `blocks`. Returns
	 * whether the channel is usable this search; any failure degrades to keyword-only. Never throws.
	 */
	private async applyVectorChannel(
		query: string,
		scope: "global" | "project" | "all",
		cwd: string,
		blocks: SearchCandidateBlock[],
	): Promise<boolean> {
		if (!this.embedder || blocks.length === 0) return false;
		let queryVector: number[] | undefined;
		try {
			queryVector = (await this.embedder.embed([query.slice(0, EMBED_MAX_CHARS)]))[0];
		} catch {
			return false;
		}
		if (!queryVector) return false;
		const scopes: MemoryScope[] = scope === "all" ? ["global", "project"] : [scope];
		for (const indexScope of scopes) {
			const scoped = blocks.filter((block) => block.fileScope === indexScope && this.isCurrentCandidate(block));
			if (scoped.length === 0) continue;
			try {
				const indexPath =
					indexScope === "global"
						? join(this.root, ".memory-index.json")
						: join(projectMemoryDir(this.root, cwd), ".memory-index.json");
				const index = new MemoryVectorIndex(indexPath, this.embedder.model);
				const indexable: IndexableBlock[] = scoped.map((block) => ({ key: block.key, text: block.text }));
				await index.ensure(indexable, this.embedder, (candidate) => {
					const block = scoped.find((item) => item.key === candidate.key);
					return block !== undefined && this.isCurrentCandidate(block);
				});
				const similarities = index.similar(queryVector, VECTOR_MIN_SIMILARITY);
				for (const block of scoped) {
					block.cosine = similarities.get(block.key) ?? 0;
				}
			} catch {
				// Vector channel is best-effort per scope; keyword scoring is unaffected.
			}
		}
		return true;
	}

	/** memory_get (spec 10.4): reads a file by path relative to (or absolute but still inside) the memory root. */
	get(relativeOrAbsolutePath: string): string | undefined {
		if (!isPathWithinScope(relativeOrAbsolutePath, this.root, this.root)) return undefined;
		const resolved = resolve(this.root, relativeOrAbsolutePath);
		try {
			if (!statSync(resolved).isFile()) return undefined;
		} catch {
			return undefined;
		}
		return this.validBlocks(resolved)
			.map((block) => block.body)
			.join("\n\n");
	}

	/**
	 * autoDream Phase 2 (spec 10.5): consolidates session notes accumulated since the last run into a
	 * condensed section of the *project* MEMORY.md (never global — that always needs human confirmation).
	 * Gated by both a time interval and a minimum number of new session notes, and guarded by a lock file
	 * so two concurrent callers (e.g. two sessions in the same project) never consolidate at once.
	 * Summarization itself is caller-supplied: this module is model-agnostic by design (see BashOperations
	 * / WebSearchOperations for the same pattern elsewhere in this codebase).
	 */
	private noteSnapshots(cwd: string): NoteSnapshot[] {
		const dir = projectSessionsDir(this.root, cwd);
		if (!existsSync(dir)) return [];
		const notes: NoteSnapshot[] = [];
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			const path = join(dir, name);
			if (!isPathWithinScope(path, this.root, this.root)) throw new Error("Memory path outside scope");
			const { metadata, body } = parseNote(readFileSync(path, "utf8"));
			if (!metadata) continue;
			const content = this.validBlocks(path)
				.map((block) => block.body)
				.join("\n\n");
			if (!content.trim()) continue;
			notes.push({ ...metadata, path, content, storedHash: hashContent(body) });
		}
		return notes;
	}

	private commitDream(cwd: string, commit: DreamCommit, state: DreamState, statePath: string): ConsolidationResult {
		const memoryFile = projectMemoryFile(this.root, cwd);
		const release = lockfile.lockSync(memoryFile, { realpath: false });
		try {
			const raw = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "";
			const existingIds = new Set(parseBlocks(raw).map((block) => block.id));
			let appended = "";
			for (const [index, fact] of commit.extraction.facts.entries()) {
				const id = `mem-${commit.batchId}-${index}`;
				if (existingIds.has(id)) continue;
				appended += `\n<!-- id:${id} -->\n## Consolidated memory (autoDream) — ${new Date(commit.createdAt).toISOString()}\n<!-- source-notes: ${fact.sourceNoteIds.join(", ")} -->\n\n${fact.text.trim()}\n`;
			}
			if (appended) writeAtomic(memoryFile, raw + appended);
			const processed = { ...state.processed };
			for (const source of commit.sources) processed[source.id] = source.hash;
			writeAtomic(statePath, JSON.stringify({ lastConsolidatedAt: commit.createdAt, processed }));
			return {
				ran: true,
				reason: commit.extraction.facts.length ? "consolidated" : "processed_no_facts",
				written: commit.extraction.facts.length,
				batchId: commit.batchId,
				sourceNoteIds: commit.sources.map((source) => source.id),
			};
		} finally {
			release();
		}
	}

	async maybeConsolidate(options: ConsolidateOptions): Promise<ConsolidationResult> {
		const dir = projectMemoryDir(this.root, options.cwd);
		if (!existsSync(dir)) return { ran: false, reason: "no session notes" };
		const statePath = join(dir, ".dream-state.json");
		const journalPath = join(dir, ".dream-commit.json");
		const controller = new AbortController();
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		signal.throwIfAborted();
		const release = acquireDreamLock(join(dir, ".dream.lock"), () => controller.abort());
		if (!release) return { ran: false, reason: "consolidation is already in progress (lock held)" };
		try {
			const state = readDreamState(statePath);
			const allNotes = this.noteSnapshots(options.cwd);
			if (existsSync(journalPath)) {
				let commit: DreamCommit;
				try {
					commit = JSON.parse(readFileSync(journalPath, "utf8")) as DreamCommit;
				} catch {
					throw new Error("invalid_memory_commit");
				}
				if (
					!commit ||
					!Array.isArray(commit.sources) ||
					commit.sources.length === 0 ||
					commit.sources.some(
						(source) =>
							!source ||
							typeof source.id !== "string" ||
							typeof source.hash !== "string" ||
							typeof source.viewHash !== "string",
					) ||
					!Number.isFinite(commit.createdAt) ||
					commit.batchId !== hashContent(JSON.stringify(commit.sources)).slice(0, 16)
				)
					throw new Error("invalid_memory_commit");
				if (
					commit.sources.some(
						(source) =>
							!allNotes.some(
								(note) =>
									note.id === source.id &&
									note.storedHash === source.hash &&
									hashContent(note.content) === source.viewHash,
							),
					)
				)
					throw new Error("memory_source_changed");
				validateMemoryExtraction(commit.extraction, new Set(commit.sources.map((source) => source.id)));
				if (commit.extraction.facts.some((fact) => !checkMemoryCandidate(fact.text).safe))
					throw new Error("unsafe_memory_extraction");
				signal.throwIfAborted();
				const result = this.commitDream(options.cwd, commit, state, statePath);
				rmSync(journalPath);
				return result;
			}
			if (Date.now() - state.lastConsolidatedAt < (options.minIntervalMs ?? 86400000))
				return { ran: false, reason: "too soon since the last consolidation" };
			const pending = allNotes.filter(
				(note) =>
					state.processed[note.id] !== note.storedHash &&
					!(
						state.processed[note.id] === note.contentHash &&
						parseNote(readFileSync(note.path, "utf8")).metadata?.storedHash === note.storedHash
					),
			);
			const count = new Set(pending.map((note) => note.sessionId)).size;
			if (count < (options.minNewSessions ?? 3))
				return {
					ran: false,
					reason: `only ${count} new session note session(s); need at least ${options.minNewSessions ?? 3}`,
				};
			const selected: NoteSnapshot[] = [];
			for (const note of pending) {
				if (!options.inputFits || options.inputFits([...selected, note])) selected.push(note);
			}
			if (selected.length === 0) return { ran: false, reason: "memory_input_budget" };
			const extraction = validateMemoryExtraction(
				await options.summarize(selected, signal),
				new Set(selected.map((note) => note.id)),
			);
			signal.throwIfAborted();
			if (extraction.facts.some((fact) => !checkMemoryCandidate(fact.text).safe))
				throw new Error("unsafe_memory_extraction");
			const current = this.noteSnapshots(options.cwd);
			if (
				selected.some(
					(note) =>
						!current.some(
							(candidate) =>
								candidate.id === note.id &&
								candidate.storedHash === note.storedHash &&
								candidate.content === note.content,
						),
				)
			)
				throw new Error("memory_source_changed");
			const sources = selected.map((note) => ({
				id: note.id,
				hash: note.storedHash,
				viewHash: hashContent(note.content),
			}));
			const commit: DreamCommit = {
				batchId: hashContent(JSON.stringify(sources)).slice(0, 16),
				sources,
				extraction,
				createdAt: Date.now(),
			};
			writeAtomic(journalPath, JSON.stringify(commit));
			signal.throwIfAborted();
			const result = this.commitDream(options.cwd, commit, state, statePath);
			rmSync(journalPath);
			return result;
		} finally {
			release();
		}
	}
}
