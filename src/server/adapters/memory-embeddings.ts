import { createHash } from "node:crypto";
import { memoryEmbeddingQuery } from "#/domain/memory-repo";
import { memoryEmbeddings, saveMemoryEmbeddings } from "./memory-settings";

/**
 * Workers AI text embeddings for the read hook; vectors are cached per line
 * text. Cost is ours (cents per million tokens), not billed per user.
 * Queries and documents embed differently (Qwen3 is asymmetric).
 */
const MEMORY_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
const BATCH = 32;
/** A new memory of a few hundred lines embeds in about one round trip. */
const PARALLEL_BATCHES = 4;
/**
 * The query side carries Qwen3's "Instruct: …\nQuery: …" prefix; sent as a
 * document so the service adds no instruction of its own.
 */
const QUERY_INPUT = (text: string) => ({
	documents: [memoryEmbeddingQuery(text)],
});

type RerankInput = { query: string; contexts: { text: string }[] };
type AiBinding = {
	run(
		model: string,
		input: { queries?: string[]; documents?: string[] } | RerankInput,
	): Promise<{ data?: number[][] } | unknown>;
};
export type Embed = {
	query(text: string): Promise<number[]>;
	documents(texts: readonly string[]): Promise<number[][]>;
};
type Run = (input: {
	queries?: string[];
	documents?: string[];
}) => Promise<number[][]>;

let binding: AiBinding | undefined;

export function registerMemoryEmbeddings(ai: AiBinding | undefined) {
	if (ai) binding = ai;
}

function embedder(run: Run): Embed {
	return {
		query: async (text) => {
			const [vector] = await run(QUERY_INPUT(text));
			if (!vector) throw new Error("Embedding model returned no data.");
			return vector;
		},
		documents: async (texts) => {
			const batches: string[][] = [];
			for (let start = 0; start < texts.length; start += BATCH)
				batches.push(texts.slice(start, start + BATCH));
			const results: number[][][] = new Array(batches.length);
			let next = 0;
			const worker = async () => {
				while (next < batches.length) {
					const index = next++;
					results[index] = await run({ documents: batches[index] });
				}
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(PARALLEL_BATCHES, batches.length) },
					worker,
				),
			);
			const out = results.flat();
			if (out.length !== texts.length)
				throw new Error("Embedding model returned no data.");
			return out;
		},
	};
}

/**
 * A model call on the Workers AI binding, or its REST API when an account
 * token is configured (scripts); null when neither is.
 */
function aiRunner() {
	const ai = binding;
	if (ai)
		return (model: string, input: Parameters<AiBinding["run"]>[1]) =>
			ai.run(model, input);
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!account || !token) return null;
	return async (model: string, input: Parameters<AiBinding["run"]>[1]) => {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(input),
			},
		);
		const body = (await response.json()) as { result?: unknown };
		if (!response.ok)
			throw new Error(`Workers AI request failed (${response.status}).`);
		return body.result;
	};
}

/** The Workers AI binding, or its REST API when an account token is configured (scripts). */
export function memoryEmbedder(): Embed | null {
	const run = aiRunner();
	if (!run) return null;
	return embedder(async (input) => {
		const result = (await run(MEMORY_EMBEDDING_MODEL, input)) as
			| { data?: number[][] }
			| undefined;
		return result?.data ?? [];
	});
}

/**
 * A cross-encoder reading the request and each line together, after the
 * hybrid ranking picked the candidates: the read hook keeps a line only when
 * this scores it as relevant (memory-repo.ts, MEMORY_RERANK_MIN_SCORE).
 */
const MEMORY_RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** Relevance of each text to the query, 0-1, in `texts` order. */
export type Rerank = (
	query: string,
	texts: readonly string[],
) => Promise<number[]>;

/**
 * The Workers AI reranker (binding, else REST), or null. Its answer lists
 * `{ id, score }` by context index, best first; scores are already 0-1
 * (a raw logit is passed through a sigmoid).
 */
export function memoryReranker(): Rerank | null {
	const run = aiRunner();
	if (!run) return null;
	return async (query, texts) => {
		if (!texts.length) return [];
		const result = (await run(MEMORY_RERANK_MODEL, {
			query,
			contexts: texts.map((text) => ({ text })),
		})) as { response?: { id?: number; score?: number }[] } | undefined;
		const scores = new Array<number>(texts.length).fill(Number.NaN);
		for (const item of result?.response ?? [])
			if (
				typeof item.id === "number" &&
				typeof item.score === "number" &&
				item.id >= 0 &&
				item.id < texts.length
			)
				scores[item.id] =
					item.score >= 0 && item.score <= 1
						? item.score
						: 1 / (1 + Math.exp(-item.score));
		if (scores.some(Number.isNaN))
			throw new Error("Reranker returned no score for some lines.");
		return scores;
	};
}

function lineHash(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Line vectors this isolate already loaded or computed, by user, model and
 * line hash: a chat's later turns (and the user's next chat in the same
 * isolate) skip the database read. Bounded; the oldest entries go first.
 */
const warm = new Map<string, number[]>();
const WARM_LIMIT = 4000;
const warmKey = (userId: string, hash: string) =>
	`${userId}\n${MEMORY_EMBEDDING_MODEL}\n${hash}`;

function remember(userId: string, hash: string, vector: number[]) {
	const key = warmKey(userId, hash);
	warm.delete(key);
	warm.set(key, vector);
	while (warm.size > WARM_LIMIT)
		warm.delete(warm.keys().next().value as string);
}

/** Test seam: forget the isolate's warm vectors. */
export function resetWarmLineEmbeddings() {
	warm.clear();
}

/** Where a call's line vectors came from, and how long each source took. */
export type LineEmbeddingStats = {
	/** Lines held warm in this isolate. */
	warm: number;
	/** Lines another call in this isolate was already loading or embedding. */
	shared: number;
	/** Lines read from the database, and the read's wall time. */
	loaded: number;
	loadMs: number;
	/** Lines embedded now, and the embedding calls' wall time. */
	embedded: number;
	embedMs: number;
};

/**
 * Cold lines a call in this isolate is loading or embedding right now, by
 * warm key: a second call for the same lines (the turn's prefetch and a read
 * hook on a newer snapshot) waits for them instead of repeating the work.
 */
const inFlight = new Map<string, Promise<number[] | undefined>>();

/**
 * Embeddings for `texts`: vectors this isolate holds, then cached ones from
 * the database, the rest computed once and saved. Unchanged lines are never
 * embedded again, and a warm isolate reads nothing. With `saveInBackground`
 * (the read hook) the vectors are returned before the database write ends.
 */
export async function cachedLineEmbeddings(
	userId: string,
	texts: readonly string[],
	embed: Embed,
	cache = { load: memoryEmbeddings, save: saveMemoryEmbeddings },
	options: { stats?: LineEmbeddingStats; saveInBackground?: boolean } = {},
) {
	const hashes = texts.map(lineHash);
	const known = new Map<string, number[]>();
	for (const hash of hashes) {
		const vector = warm.get(warmKey(userId, hash));
		if (vector) known.set(hash, vector);
	}
	const unknown = [...new Set(hashes.filter((hash) => !known.has(hash)))];
	const shared = unknown.filter((hash) => inFlight.has(warmKey(userId, hash)));
	const cold = unknown.filter((hash) => !inFlight.has(warmKey(userId, hash)));
	const sharing = shared.map((hash) => inFlight.get(warmKey(userId, hash)));
	const stats = options.stats;
	if (stats) {
		stats.warm += hashes.length - unknown.length;
		stats.shared += shared.length;
	}
	let settle: (vectors: Map<string, number[]>) => void = () => {};
	const settled = new Promise<Map<string, number[]>>((resolve) => {
		settle = resolve;
	});
	for (const hash of cold) {
		const key = warmKey(userId, hash);
		inFlight.set(
			key,
			settled.then((vectors) => vectors.get(hash)),
		);
	}
	const found = new Map<string, number[]>();
	try {
		if (cold.length) {
			const started = Date.now();
			for (const [hash, vector] of await cache.load(
				userId,
				MEMORY_EMBEDDING_MODEL,
				cold,
			)) {
				known.set(hash, vector);
				found.set(hash, vector);
				remember(userId, hash, vector);
			}
			if (stats) {
				stats.loaded += found.size;
				stats.loadMs += Date.now() - started;
			}
		}
		const missing = cold.filter((hash) => !known.has(hash));
		if (missing.length) {
			const byHash = new Map(hashes.map((hash, index) => [hash, texts[index]]));
			const started = Date.now();
			const vectors = await embed.documents(
				missing.map((hash) => byHash.get(hash) ?? ""),
			);
			if (stats) {
				stats.embedded += missing.length;
				stats.embedMs += Date.now() - started;
			}
			const rows = missing.map((hash, index) => ({
				hash,
				embedding: vectors[index],
			}));
			for (const row of rows) {
				known.set(row.hash, row.embedding);
				found.set(row.hash, row.embedding);
				remember(userId, row.hash, row.embedding);
			}
			const saving = cache.save(userId, MEMORY_EMBEDDING_MODEL, rows);
			if (options.saveInBackground)
				saving.catch(() => {
					console.warn("Memory line vectors could not be saved.");
				});
			else await saving;
		}
	} finally {
		settle(found);
		for (const hash of cold) inFlight.delete(warmKey(userId, hash));
	}
	// Lines another call was fetching; one it failed to fetch is fetched here.
	const waited = await Promise.all(sharing);
	const retry: string[] = [];
	shared.forEach((hash, index) => {
		const vector = waited[index] ?? warm.get(warmKey(userId, hash));
		if (vector) known.set(hash, vector);
		else retry.push(hash);
	});
	if (retry.length) {
		const byHash = new Map(hashes.map((hash, index) => [hash, texts[index]]));
		const again = await cachedLineEmbeddings(
			userId,
			retry.map((hash) => byHash.get(hash) ?? ""),
			embed,
			cache,
			options,
		);
		retry.forEach((hash, index) => {
			known.set(hash, again[index] ?? []);
		});
	}
	return hashes.map((hash) => known.get(hash) ?? []);
}
