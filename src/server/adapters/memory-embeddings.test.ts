import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory-settings", () => ({
	memoryEmbeddings: vi.fn(async () => new Map()),
	saveMemoryEmbeddings: vi.fn(async () => {}),
}));

const { cachedLineEmbeddings, resetWarmLineEmbeddings } = await import(
	"./memory-embeddings"
);

const embed = {
	query: async () => [1],
	documents: vi.fn(async (texts: readonly string[]) =>
		texts.map((text) => [text.length]),
	),
};

beforeEach(() => {
	resetWarmLineEmbeddings();
	embed.documents.mockClear();
});

describe("line vectors", () => {
	it("embeds only new lines, and a warm isolate skips the database", async () => {
		const stored = new Map<string, number[]>();
		const cache = {
			load: vi.fn(
				async (user: string, _model: string, hashes: readonly string[]) =>
					new Map(
						hashes.flatMap((hash) => {
							const vector = stored.get(`${user}:${hash}`);
							return vector ? [[hash, vector] as const] : [];
						}),
					),
			),
			save: vi.fn(
				async (
					user: string,
					_model: string,
					rows: readonly { hash: string; embedding: readonly number[] }[],
				) => {
					for (const row of rows)
						stored.set(`${user}:${row.hash}`, [...row.embedding]);
				},
			),
		};
		expect(await cachedLineEmbeddings("u1", ["a", "bb"], embed, cache)).toEqual(
			[[1], [2]],
		);
		expect(embed.documents).toHaveBeenCalledWith(["a", "bb"]);
		expect(cache.save).toHaveBeenCalledTimes(1);

		// Same isolate: no database read, only the changed line is embedded.
		cache.load.mockClear();
		embed.documents.mockClear();
		expect(
			await cachedLineEmbeddings("u1", ["a", "bb", "ccc"], embed, cache),
		).toEqual([[1], [2], [3]]);
		expect(cache.load).toHaveBeenCalledWith("u1", expect.any(String), [
			expect.any(String),
		]);
		expect(embed.documents).toHaveBeenCalledWith(["ccc"]);

		// A cold isolate reads the stored vectors and embeds nothing.
		resetWarmLineEmbeddings();
		embed.documents.mockClear();
		expect(
			await cachedLineEmbeddings("u1", ["a", "bb", "ccc"], embed, cache),
		).toEqual([[1], [2], [3]]);
		expect(embed.documents).not.toHaveBeenCalled();

		// Vectors are per user.
		expect(await cachedLineEmbeddings("u2", ["a"], embed, cache)).toEqual([
			[1],
		]);
		expect(embed.documents).toHaveBeenCalledWith(["a"]);
	});
});
