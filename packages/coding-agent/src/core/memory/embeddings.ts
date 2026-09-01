/**
 * Embedding support for the memory system's vector recall channel. Zero new dependencies: the
 * production embedder speaks the OpenAI-compatible `POST {baseUrl}/embeddings` protocol over Node's
 * built-in fetch (same precedent as tools/web-fetch.ts). The embedder is caller-injected into
 * MemoryStore — tests use a deterministic fake, and an unconfigured setup stays fully offline with
 * the keyword channel intact.
 */

export interface MemoryEmbedder {
	/** Model identifier; the vector index rebuilds from scratch when it changes. */
	readonly model: string;
	/** Embeds a batch of texts, returning one vector per input in the same order. */
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Settings shape stored under `memory.embedding` in settings.json (see settings-manager.ts). The
 * API key itself never lives in settings — only the *name* of the environment variable holding it.
 */
export interface MemoryEmbeddingSettings {
	baseUrl?: string; // e.g. "https://dashscope.aliyuncs.com/compatible-mode/v1"
	model?: string; // e.g. "text-embedding-v4"
	apiKeyEnv?: string; // name of the env var holding the key, e.g. "DASHSCOPE_API_KEY"
	dimensions?: number; // optional, forwarded to the API when set
}

export interface ResolvedEmbeddingConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
	dimensions?: number;
}

/** Texts per embeddings request. */
export const EMBED_BATCH_SIZE = 32;
/** Per-request timeout; a slow endpoint must never hang memory_search. */
export const EMBED_TIMEOUT_MS = 10_000;
/** Longer block texts are truncated before embedding. */
export const EMBED_MAX_CHARS = 4000;

/**
 * The vector channel is on only when all three fields are configured *and* the named env var
 * actually holds a value. Anything less returns undefined, which keeps search keyword-only.
 */
export function resolveEmbeddingConfig(
	settings: MemoryEmbeddingSettings | undefined,
	env: NodeJS.ProcessEnv,
): ResolvedEmbeddingConfig | undefined {
	if (!settings?.baseUrl || !settings.model || !settings.apiKeyEnv) return undefined;
	const apiKey = env[settings.apiKeyEnv];
	if (!apiKey) return undefined;
	return {
		baseUrl: settings.baseUrl.replace(/\/+$/, ""),
		model: settings.model,
		apiKey,
		dimensions: settings.dimensions,
	};
}

/** OpenAI-compatible embeddings client (dashscope, OpenAI, and most gateways speak this shape). */
export function createOpenAiCompatibleEmbedder(config: ResolvedEmbeddingConfig): MemoryEmbedder {
	return {
		model: config.model,
		async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
			const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS);
			const response = await fetch(`${config.baseUrl}/embeddings`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
				body: JSON.stringify({
					model: config.model,
					input: texts,
					...(config.dimensions !== undefined ? { dimensions: config.dimensions } : {}),
				}),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (!response.ok) throw new Error(`embeddings request failed: HTTP ${response.status}`);
			const payload = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
			const rows = payload.data ?? [];
			if (rows.length !== texts.length) {
				throw new Error(`embeddings response returned ${rows.length} vectors for ${texts.length} inputs`);
			}
			// Providers may return rows out of order; the row's own index is authoritative.
			const vectors: number[][] = new Array(texts.length);
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i]!;
				const at = typeof row.index === "number" ? row.index : i;
				if (!Array.isArray(row.embedding) || at < 0 || at >= texts.length) {
					throw new Error("embeddings response is malformed");
				}
				vectors[at] = row.embedding;
			}
			return vectors;
		},
	};
}

/** L2 normalization; the zero vector stays zero. */
export function normalizeVector(vector: number[]): number[] {
	let sum = 0;
	for (const value of vector) sum += value * value;
	const norm = Math.sqrt(sum);
	if (norm === 0) return vector.map(() => 0);
	return vector.map((value) => value / norm);
}

/** Dot product; equals cosine similarity when both vectors are L2-normalized. */
export function dot(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < length; i++) sum += a[i]! * b[i]!;
	return sum;
}
