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

type AiBinding = {
	run(
		model: string,
		input: { queries?: string[]; documents?: string[] },
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

/** The Workers AI binding, or its REST API when an account token is configured (scripts). */
export function memoryEmbedder(): Embed | null {
	const ai = binding;
	if (ai)
		return embedder(async (input) => {
			const result = (await ai.run(MEMORY_EMBEDDING_MODEL, input)) as {
				data?: number[][];
			};
			return result.data ?? [];
		});
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!account || !token) return null;
	return embedder(async (input) => {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MEMORY_EMBEDDING_MODEL}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(input),
			},
		);
		const body = (await response.json()) as { result?: { data?: number[][] } };
		if (!response.ok)
			throw new Error(`Embedding request failed (${response.status}).`);
		return body.result?.data ?? [];
	});
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

/**
 * Embeddings for `texts`: vectors this isolate holds, then cached ones from
 * the database, the rest computed once and saved. Unchanged lines are never
 * embedded again, and a warm isolate reads nothing.
 */
export async function cachedLineEmbeddings(
	userId: string,
	texts: readonly string[],
	embed: Embed,
	cache = { load: memoryEmbeddings, save: saveMemoryEmbeddings },
) {
	const hashes = texts.map(lineHash);
	const known = new Map<string, number[]>();
	for (const hash of hashes) {
		const vector = warm.get(warmKey(userId, hash));
		if (vector) known.set(hash, vector);
	}
	const cold = [...new Set(hashes.filter((hash) => !known.has(hash)))];
	if (cold.length)
		for (const [hash, vector] of await cache.load(
			userId,
			MEMORY_EMBEDDING_MODEL,
			cold,
		)) {
			known.set(hash, vector);
			remember(userId, hash, vector);
		}
	const missing = cold.filter((hash) => !known.has(hash));
	if (missing.length) {
		const byHash = new Map(hashes.map((hash, index) => [hash, texts[index]]));
		const vectors = await embed.documents(
			missing.map((hash) => byHash.get(hash) ?? ""),
		);
		const rows = missing.map((hash, index) => ({
			hash,
			embedding: vectors[index],
		}));
		for (const row of rows) {
			known.set(row.hash, row.embedding);
			remember(userId, row.hash, row.embedding);
		}
		await cache.save(userId, MEMORY_EMBEDDING_MODEL, rows);
	}
	return hashes.map((hash) => known.get(hash) ?? []);
}
