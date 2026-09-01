import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createOpenAiCompatibleEmbedder,
	type MemoryEmbedder,
	normalizeVector,
	resolveEmbeddingConfig,
} from "../src/core/memory/embeddings.ts";
import { MemoryStore, projectMemoryDir, projectMemoryFile, VECTOR_WEIGHT } from "../src/core/memory/memory-store.ts";

/**
 * Vector recall channel: config resolution, lazy sidecar index maintenance, keyword+vector fusion,
 * and graceful degradation to keyword-only. All embeddings come from a deterministic fake — no
 * network, no real models.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

/** Topic-axis vectors: texts about the same topic are identical, different topics are orthogonal. */
function topicVector(text: string): number[] {
	const lower = text.toLowerCase();
	if (lower.includes("login") || lower.includes("authentication")) return [1, 0, 0];
	if (lower.includes("database")) return [0, 1, 0];
	return [0, 0, 1];
}

class FakeEmbedder implements MemoryEmbedder {
	readonly model: string;
	readonly calls: string[][] = [];
	private readonly vectorFor: (text: string) => number[];
	private readonly failOn: (texts: string[]) => boolean;

	constructor(
		model = "fake-v1",
		options?: { vectorFor?: (text: string) => number[]; failOn?: (texts: string[]) => boolean },
	) {
		this.model = model;
		this.vectorFor = options?.vectorFor ?? topicVector;
		this.failOn = options?.failOn ?? (() => false);
	}

	async embed(texts: string[]): Promise<number[][]> {
		this.calls.push([...texts]);
		if (this.failOn(texts)) throw new Error("fake embed failure");
		return texts.map((text) => this.vectorFor(text));
	}
}

function createStore(embedder?: MemoryEmbedder): { store: MemoryStore; root: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-memory-embed-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	return { store: new MemoryStore(root, embedder), root, cwd };
}

function block(id: string, iso: string, body: string): string {
	return `\n<!-- id:${id} -->\n## Project memory — ${iso}\n\n${body}\n`;
}

function writeProjectMemory(root: string, cwd: string, content: string): void {
	mkdirSync(projectMemoryDir(root, cwd), { recursive: true });
	writeFileSync(projectMemoryFile(root, cwd), content, "utf-8");
}

function indexPath(root: string, cwd: string): string {
	return join(projectMemoryDir(root, cwd), ".memory-index.json");
}

describe("resolveEmbeddingConfig", () => {
	it("resolves only when baseUrl, model, apiKeyEnv, and the env value are all present", () => {
		const settings = { baseUrl: "https://api.example.com/v1/", model: "embed-1", apiKeyEnv: "EMBED_KEY" };
		const resolved = resolveEmbeddingConfig(settings, { EMBED_KEY: "sk-test" });
		expect(resolved).toEqual({
			baseUrl: "https://api.example.com/v1",
			model: "embed-1",
			apiKey: "sk-test",
			dimensions: undefined,
		});
	});

	it("returns undefined for missing fields or an empty env var", () => {
		const env = { EMBED_KEY: "sk-test" };
		expect(resolveEmbeddingConfig(undefined, env)).toBeUndefined();
		expect(resolveEmbeddingConfig({ model: "m", apiKeyEnv: "EMBED_KEY" }, env)).toBeUndefined();
		expect(resolveEmbeddingConfig({ baseUrl: "https://x", apiKeyEnv: "EMBED_KEY" }, env)).toBeUndefined();
		expect(resolveEmbeddingConfig({ baseUrl: "https://x", model: "m" }, env)).toBeUndefined();
		expect(resolveEmbeddingConfig({ baseUrl: "https://x", model: "m", apiKeyEnv: "EMBED_KEY" }, {})).toBeUndefined();
	});
});

describe("MemoryStore.search vector channel", () => {
	const iso = new Date().toISOString();

	it("builds the sidecar index on first search and reuses it on the second", async () => {
		const embedder = new FakeEmbedder();
		const { store, root, cwd } = createStore(embedder);
		writeProjectMemory(
			root,
			cwd,
			block("mem-auth0001", iso, "authentication requires an OAuth token") +
				block("mem-data0001", iso, "database connection pooling defaults"),
		);
		await store.search("database", "project", cwd);
		// First search: one query call + one batch call for both blocks.
		expect(embedder.calls).toHaveLength(2);
		expect(embedder.calls[1]).toHaveLength(2);
		expect(existsSync(indexPath(root, cwd))).toBe(true);

		await store.search("database", "project", cwd);
		// Second search: only the query is embedded.
		expect(embedder.calls).toHaveLength(3);
		expect(embedder.calls[2]).toEqual(["database"]);
	});

	it("re-embeds only new blocks incrementally", async () => {
		const embedder = new FakeEmbedder();
		const { store, root, cwd } = createStore(embedder);
		writeProjectMemory(root, cwd, block("mem-auth0001", iso, "authentication requires an OAuth token"));
		await store.search("token", "project", cwd);
		writeProjectMemory(
			root,
			cwd,
			block("mem-auth0001", iso, "authentication requires an OAuth token") +
				block("mem-data0001", iso, "database connection pooling defaults"),
		);
		await store.search("token", "project", cwd);
		const lastBatch = embedder.calls.at(-1)!;
		expect(lastBatch).toHaveLength(1);
		expect(lastBatch[0]).toContain("database");
	});

	it("rebuilds the whole index when the embedder model changes", async () => {
		const { store, root, cwd } = createStore(new FakeEmbedder("fake-v1"));
		writeProjectMemory(
			root,
			cwd,
			block("mem-auth0001", iso, "authentication requires an OAuth token") +
				block("mem-data0001", iso, "database connection pooling defaults"),
		);
		await store.search("token", "project", cwd);

		const upgraded = new FakeEmbedder("fake-v2");
		const storeV2 = new MemoryStore(root, upgraded);
		await storeV2.search("token", "project", cwd);
		// Model mismatch invalidated every entry: both blocks re-embedded.
		expect(upgraded.calls.at(-1)).toHaveLength(2);
		expect(readFileSync(indexPath(root, cwd), "utf-8")).toContain('"model":"fake-v2"');
	});

	it("recalls a semantically related block with zero keyword overlap", async () => {
		const { store, root, cwd } = createStore(new FakeEmbedder());
		writeProjectMemory(
			root,
			cwd,
			block("mem-auth0001", iso, "authentication requires an OAuth token") +
				block("mem-data0001", iso, "database connection pooling defaults"),
		);
		// "login" appears nowhere in the memory: the keyword channel alone finds nothing.
		const hits = await store.search("login", "project", cwd);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.snippet).toContain("OAuth");
		// Fused relevance = VECTOR_WEIGHT × cosine(1.0) with a fresh block (decay ≈ 1).
		expect(hits[0]!.score).toBeGreaterThan(VECTOR_WEIGHT - 0.05);
	});

	it("drops blocks below the similarity floor when keywords also miss", async () => {
		const { store, root, cwd } = createStore(new FakeEmbedder());
		writeProjectMemory(
			root,
			cwd,
			block("mem-auth0001", iso, "authentication requires an OAuth token") +
				block("mem-data0001", iso, "database connection pooling defaults"),
		);
		// "deploy pipeline" maps to the third axis: orthogonal to both blocks, no term overlap.
		expect(await store.search("deploy pipeline", "project", cwd)).toHaveLength(0);
	});

	it("falls back to keyword-only when embedding the query fails", async () => {
		const { store, root, cwd } = createStore(new FakeEmbedder("fake-v1", { failOn: () => true }));
		writeProjectMemory(root, cwd, block("mem-auth0001", iso, "authentication requires an OAuth token"));
		const hits = await store.search("authentication", "project", cwd);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.snippet).toContain("OAuth");
	});

	it("keeps keyword hits when batch embedding fails midway", async () => {
		// The query (single text) succeeds; the two-block batch fails.
		const embedder = new FakeEmbedder("fake-v1", { failOn: (texts) => texts.length > 1 });
		const { store, root, cwd } = createStore(embedder);
		writeProjectMemory(
			root,
			cwd,
			block("mem-auth0001", iso, "authentication requires an OAuth token") +
				block("mem-data0001", iso, "database connection pooling defaults"),
		);
		const hits = await store.search("authentication", "project", cwd);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.snippet).toContain("OAuth");
	});
});

describe("createOpenAiCompatibleEmbedder", () => {
	const config = { baseUrl: "https://api.example.com/v1", model: "embed-1", apiKey: "sk-test", dimensions: 3 };

	it("sends an OpenAI-compatible request and maps rows by their index field", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				// Rows deliberately out of order: the index field is authoritative.
				data: [
					{ index: 1, embedding: [0, 1, 0] },
					{ index: 0, embedding: [1, 0, 0] },
				],
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const vectors = await createOpenAiCompatibleEmbedder(config).embed(["first", "second"]);
		expect(vectors).toEqual([
			[1, 0, 0],
			[0, 1, 0],
		]);
		const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
		expect(url).toBe("https://api.example.com/v1/embeddings");
		expect(init.headers).toMatchObject({ authorization: "Bearer sk-test" });
		expect(JSON.parse(init.body as string)).toEqual({ model: "embed-1", input: ["first", "second"], dimensions: 3 });
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("throws on a non-ok response and on a count mismatch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);
		await expect(createOpenAiCompatibleEmbedder(config).embed(["x"])).rejects.toThrow("HTTP 500");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
		);
		await expect(createOpenAiCompatibleEmbedder(config).embed(["x"])).rejects.toThrow("returned 0 vectors");
	});
});

describe("normalizeVector", () => {
	it("produces unit length and leaves the zero vector alone", () => {
		const unit = normalizeVector([3, 4]);
		expect(unit[0]).toBeCloseTo(0.6);
		expect(unit[1]).toBeCloseTo(0.8);
		expect(normalizeVector([0, 0])).toEqual([0, 0]);
	});
});
