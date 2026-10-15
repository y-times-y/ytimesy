import { createHash } from "node:crypto";
import { memoryEmbeddings, saveMemoryEmbeddings } from "./memory-settings";

/** Workers AI text embeddings for the read hook; vectors are cached per line text. */
export const MEMORY_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const BATCH = 100;

type AiBinding = {
	run(
		model: string,
		input: { text: string[] },
	): Promise<{ data?: number[][] } | unknown>;
};
export type Embed = (texts: readonly string[]) => Promise<number[][]>;

let binding: AiBinding | undefined;

export function registerMemoryEmbeddings(ai: AiBinding | undefined) {
	if (ai) binding = ai;
}

/** The Workers AI binding, or its REST API when an account token is configured (scripts). */
export function memoryEmbedder(): Embed | null {
	const ai = binding;
	if (ai)
		return async (texts) => {
			const out: number[][] = [];
			for (let start = 0; start < texts.length; start += BATCH) {
				const result = (await ai.run(MEMORY_EMBEDDING_MODEL, {
					text: texts.slice(start, start + BATCH),
				})) as { data?: number[][] };
				if (!result.data) throw new Error("Embedding model returned no data.");
				out.push(...result.data);
			}
			return out;
		};
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!account || !token) return null;
	return async (texts) => {
		const out: number[][] = [];
		for (let start = 0; start < texts.length; start += BATCH) {
			const response = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MEMORY_EMBEDDING_MODEL}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ text: texts.slice(start, start + BATCH) }),
				},
			);
			const body = (await response.json()) as {
				result?: { data?: number[][] };
			};
			if (!response.ok || !body.result?.data)
				throw new Error(`Embedding request failed (${response.status}).`);
			out.push(...body.result.data);
		}
		return out;
	};
}

export function lineHash(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Embeddings for `texts`: cached ones from the database, the rest computed
 * once and saved. Unchanged lines are never embedded again.
 */
export async function cachedLineEmbeddings(
	userId: string,
	texts: readonly string[],
	embed: Embed,
	cache = { load: memoryEmbeddings, save: saveMemoryEmbeddings },
) {
	const hashes = texts.map(lineHash);
	const known = await cache.load(userId, MEMORY_EMBEDDING_MODEL, [
		...new Set(hashes),
	]);
	const missing = [...new Set(hashes.filter((hash) => !known.has(hash)))];
	if (missing.length) {
		const byHash = new Map(hashes.map((hash, index) => [hash, texts[index]]));
		const vectors = await embed(missing.map((hash) => byHash.get(hash) ?? ""));
		const rows = missing.map((hash, index) => ({
			hash,
			embedding: vectors[index],
		}));
		for (const row of rows) known.set(row.hash, row.embedding);
		await cache.save(userId, MEMORY_EMBEDDING_MODEL, rows);
	}
	return hashes.map((hash) => known.get(hash) ?? []);
}
