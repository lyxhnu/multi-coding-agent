/**
 * JSON sidecar vector index for the memory system — one per scope, stored next to the files it
 * indexes (`<root>/.memory-index.json` for global, `<root>/<hash>/.memory-index.json` for a
 * project). A pure cache: deleting the sidecar just forces a rebuild; it never participates in
 * tombstones or undo. Vectors are stored L2-normalized so similarity is a plain dot product.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dot, EMBED_BATCH_SIZE, EMBED_MAX_CHARS, type MemoryEmbedder, normalizeVector } from "./embeddings.ts";

export const MEMORY_INDEX_VERSION = 1;
/** Stale entries embedded per search, in batches — bounds latency and spend of a single search. */
export const MAX_EMBED_BATCHES_PER_SEARCH = 4;
/** Vector hits below this cosine are not considered candidates at all. */
export const VECTOR_MIN_SIMILARITY = 0.3;

export interface IndexableBlock {
	/** `md:<blockId>` for curated blocks, `note:<fileName>` for session notes, `file:<relative>` otherwise. */
	key: string;
	/** Text the vector represents (heading + body). */
	text: string;
}

interface IndexEntry {
	hash: string;
	vector: number[];
}

/** sha256 prefix used for staleness checks; content change ⇒ re-embed. */
export function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class MemoryVectorIndex {
	private readonly path: string;
	private readonly model: string;
	private readonly entries = new Map<string, IndexEntry>();
	private dirty = false;

	constructor(path: string, model: string) {
		this.path = path;
		this.model = model;
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf-8")) as {
				version?: number;
				model?: string;
				entries?: Record<string, Partial<IndexEntry>>;
			};
			// A version or model mismatch invalidates every stored vector.
			if (raw.version !== MEMORY_INDEX_VERSION || raw.model !== this.model) return;
			for (const [key, entry] of Object.entries(raw.entries ?? {})) {
				if (typeof entry?.hash === "string" && Array.isArray(entry.vector)) {
					this.entries.set(key, { hash: entry.hash, vector: entry.vector });
				}
			}
		} catch {
			// Corrupt sidecar: treat as empty and rebuild.
		}
	}

	private save(): void {
		if (!this.dirty) return;
		const entries: Record<string, IndexEntry> = {};
		for (const [key, entry] of this.entries) entries[key] = entry;
		writeFileSync(this.path, JSON.stringify({ version: MEMORY_INDEX_VERSION, model: this.model, entries }), "utf-8");
		this.dirty = false;
	}

	/**
	 * Brings the index up to date for `blocks` within the per-search budget: missing/stale entries
	 * are embedded in batches, keys no longer present (tombstoned blocks, deleted files) are dropped.
	 * An embedding failure keeps whatever is already indexed usable; the remainder is retried on the
	 * next search. Never throws.
	 */
	async ensure(
		blocks: IndexableBlock[],
		embedder: MemoryEmbedder,
		isCurrent: (block: IndexableBlock) => boolean = () => true,
	): Promise<void> {
		const wanted = new Set<string>();
		const pending: { key: string; text: string; hash: string }[] = [];
		for (const block of blocks) {
			const text = block.text.slice(0, EMBED_MAX_CHARS);
			const hash = contentHash(text);
			wanted.add(block.key);
			const existing = this.entries.get(block.key);
			if (!existing || existing.hash !== hash) pending.push({ key: block.key, text, hash });
		}
		for (const key of [...this.entries.keys()]) {
			if (!wanted.has(key)) {
				this.entries.delete(key);
				this.dirty = true;
			}
		}
		const budget = pending.slice(0, MAX_EMBED_BATCHES_PER_SEARCH * EMBED_BATCH_SIZE);
		for (let start = 0; start < budget.length; start += EMBED_BATCH_SIZE) {
			const batch = budget.slice(start, start + EMBED_BATCH_SIZE).filter(isCurrent);
			if (batch.length === 0) continue;
			let vectors: number[][];
			try {
				vectors = await embedder.embed(batch.map((item) => item.text));
			} catch {
				break; // Keep what we have; the next search retries the remainder.
			}
			if (vectors.length !== batch.length) break;
			for (let i = 0; i < batch.length; i++) {
				if (!isCurrent(batch[i]!)) continue;
				this.entries.set(batch[i]!.key, { hash: batch[i]!.hash, vector: normalizeVector(vectors[i]!) });
				this.dirty = true;
			}
		}
		try {
			this.save();
		} catch {
			// Persisting the cache is best-effort; in-memory entries still serve this search.
		}
	}

	/** Cosine similarity of every indexed key against `queryVector`, filtered by `minSimilarity`. */
	similar(queryVector: number[], minSimilarity: number): Map<string, number> {
		const normalizedQuery = normalizeVector(queryVector);
		const hits = new Map<string, number>();
		for (const [key, entry] of this.entries) {
			const similarity = dot(normalizedQuery, entry.vector);
			if (similarity >= minSimilarity) hits.set(key, similarity);
		}
		return hits;
	}
}
