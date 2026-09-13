import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { readFreestyleApiKey } from "./api-key";

describe("readFreestyleApiKey", () => {
	it("fails when the key is missing", async () => {
		const blank = await Effect.runPromiseExit(
			readFreestyleApiKey({ FREESTYLE_API_KEY: "   " }),
		);
		const missing = await Effect.runPromiseExit(readFreestyleApiKey({}));

		expect(Exit.isFailure(blank)).toBe(true);
		expect(Exit.isFailure(missing)).toBe(true);
		expect(String(blank)).toContain("MissingFreestyleApiKey");
		expect(String(missing)).toContain("FREESTYLE_API_KEY is not set");
	});

	it("returns a present key", async () => {
		await expect(
			Effect.runPromise(
				readFreestyleApiKey({ FREESTYLE_API_KEY: " fs_test " }),
			),
		).resolves.toBe("fs_test");
	});
});
