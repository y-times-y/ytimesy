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
				notice: null,
				reasoning: null,
				supportsFastMode: false,
			},
		]);
	});

	it("surfaces a provider notice from the listed model", () => {
		expect(
			sessionModelsFromListed([
				{
					id: "opencode/big-pickle",
					label: "Big Pickle",
					notice: "Free period. Prompts may be used to improve the model.",
				},
			])[0]?.notice,
		).toBe("Free period. Prompts may be used to improve the model.");
	});
});
