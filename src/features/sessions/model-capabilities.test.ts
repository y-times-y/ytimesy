import { describe, expect, it } from "vitest";
import { sessionModelsFromListed } from "./model-capabilities";

describe("sessionModelsFromListed", () => {
	it("keeps agent-listed names and does not invent reasoning or Fast", () => {
		expect(
			sessionModelsFromListed([
				{ id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
			]),
		).toEqual([
			{
				id: "gpt-5.3-codex-spark",
				label: "GPT-5.3-Codex-Spark",
				reasoning: null,
				supportsFastMode: false,
			},
		]);
	});
});
