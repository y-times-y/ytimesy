import { describe, expect, it } from "vitest";
import {
	composerListedModels,
	preferredSessionModelId,
	reasoningLevelLabel,
	sessionModelsFromListed,
} from "./model-capabilities";

describe("composerListedModels", () => {
	const remembered = [{ id: "gpt-6-luna", label: "gpt-6-luna" }];
	const catalog = [
		{ id: "gpt-6-astra", label: "GPT-6-Astra" },
		{ id: "gpt-6-luna", label: "GPT-6-Luna", supportsFastMode: true },
	];
	it("does not let a disconnected chat's single-model fallback hide the catalog", () => {
		expect(
			composerListedModels({
				sessionModels: remembered,
				catalogModels: catalog,
				rememberedModels: remembered,
				sessionConnected: false,
			}),
		).toBe(catalog);
	});
	it("uses the catalog when a connected session has not loaded models", () => {
		expect(
			composerListedModels({
				sessionModels: [],
				catalogModels: catalog,
				rememberedModels: remembered,
				sessionConnected: true,
			}),
		).toBe(catalog);
	});
	it("prefers the connected runtime's current catalog over older saved models", () => {
		expect(
			composerListedModels({
				sessionModels: catalog,
				catalogModels: remembered,
				rememberedModels: [],
				sessionConnected: true,
			}),
		).toBe(catalog);
	});
	it("retains the last-used model only when no catalog is available", () => {
		expect(
			composerListedModels({
				sessionModels: [],
				catalogModels: [],
				rememberedModels: remembered,
				sessionConnected: false,
			}),
		).toBe(remembered);
	});
});

it.each([
	["low", "Low"],
	["medium", "Medium"],
	["high", "High"],
	["xhigh", "Extra high"],
	["max", "Max"],
])("uses a short reasoning label for %s", (id, label) => {
	expect(reasoningLevelLabel(id)).toBe(label);
});

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

	it("keeps Fast only when the listed model reports it", () => {
		expect(
			sessionModelsFromListed([
				{
					id: "gpt-5.3-codex",
					label: "GPT-5.3-Codex",
					supportsFastMode: true,
				},
			])[0]?.supportsFastMode,
		).toBe(true);
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

describe("preferredSessionModelId", () => {
	const listedZen = sessionModelsFromListed([
		{ id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra" },
		{
			id: "opencode/muse-spark-1.3-contributor-free",
			label: "Muse Spark 1.3",
		},
		{
			id: "opencode/muse-spark-1.2-contributor-free",
			label: "Muse Spark 1.2",
		},
		{ id: "opencode/big-pickle", label: "Big Pickle" },
	]);

	it("reuses the last listed id instead of re-preferring Zen spark", () => {
		expect(
			preferredSessionModelId(listedZen, {
				lastUsedId: "opencode/big-pickle",
			}),
		).toBe("opencode/big-pickle");
	});

	it("skips a listed Zen spark the provider already restricted", () => {
		expect(
			preferredSessionModelId(listedZen, {
				excludedIds: ["opencode/muse-spark-1.3-contributor-free"],
			}),
		).toBe("opencode/muse-spark-1.2-contributor-free");
	});

	it("prefers listed Codex spark when the connected catalog includes it", () => {
		expect(
			preferredSessionModelId(
				sessionModelsFromListed([
					{ id: "gpt-6-astra", label: "GPT-6-Astra" },
					{ id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
				]),
			),
		).toBe("gpt-5.3-codex-spark");
	});

	it("prefers listed Zen spark 1.3 over other connected Zen models", () => {
		expect(preferredSessionModelId(listedZen)).toBe(
			"opencode/muse-spark-1.3-contributor-free",
		);
	});

	it("prefers another listed Zen spark when 1.3 is not in the catalog", () => {
		expect(
			preferredSessionModelId(
				sessionModelsFromListed([
					{ id: "opencode/nemotron-3-ultra-free", label: "Nemotron" },
					{
						id: "opencode/muse-spark-1.2-contributor-free",
						label: "Muse Spark 1.2",
					},
				]),
			),
		).toBe("opencode/muse-spark-1.2-contributor-free");
	});

	it("prefers a listed Zen free model when no spark id is listed", () => {
		expect(
			preferredSessionModelId(
				sessionModelsFromListed([
					{ id: "opencode/big-pickle", label: "Big Pickle" },
					{ id: "opencode/mimo-v2.5-free", label: "MiMo" },
				]),
			),
		).toBe("opencode/mimo-v2.5-free");
	});

	it("returns only a listed id", () => {
		const models = sessionModelsFromListed([
			{ id: "opencode/big-pickle", label: "Big Pickle" },
		]);
		const preferred = preferredSessionModelId(models);
		expect(preferred).toBe("opencode/big-pickle");
		expect(models.some((model) => model.id === preferred)).toBe(true);
	});
});
