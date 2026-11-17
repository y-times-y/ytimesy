import { expect, it } from "vitest";
import {
	API_MODEL_LIST,
	apiModelSections,
	OFFERED_API_MODELS,
} from "./api-model-list";
import { AUTHOR_LABELS } from "./browse-models";
import { availableConnectionModels } from "./model-connection";

it("names each model once and puts every section under a known maker", () => {
	const ids = API_MODEL_LIST.map((model) => model.openRouterId);
	expect(new Set(ids).size).toBe(ids.length);
	for (const section of apiModelSections())
		expect(Object.hasOwn(AUTHOR_LABELS, section)).toBe(true);
});

it("offers every listed model through an OpenRouter key, in list order", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	const offered = availableConnectionModels(
		[
			{
				id,
				provider: "openrouter",
				label: "OpenRouter",
				baseUrl: "https://openrouter.ai/api/v1",
				revision: "r",
				models: [],
			},
		],
		API_MODEL_LIST.map((model) => ({
			id: model.openRouterId,
			label: model.label,
			author: model.openRouterId.split("/")[0] ?? "",
			created: 0,
		})),
	);
	expect(offered.map((model) => model.label)).toEqual(
		OFFERED_API_MODELS.map((model) => `${model.label} · OpenRouter`),
	);
	expect(offered.map((model) => model.label).join()).not.toContain("Fable 5.1");
	// The send path still resolves a retired model the person already uses.
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "openrouter",
					label: "OpenRouter",
					baseUrl: "https://openrouter.ai/api/v1",
					revision: "r",
					models: [],
				},
			],
			API_MODEL_LIST.map((model) => ({
				id: model.openRouterId,
				label: model.label,
				author: model.openRouterId.split("/")[0] ?? "",
				created: 0,
			})),
			{ includeRetired: true },
		).some((model) => model.label.startsWith("Claude Fable 5.1")),
	).toBe(true);
});

it("offers faster speeds only through an OpenRouter key", () => {
	const connection = {
		id: "12345678-1234-4123-8123-123456789012",
		label: "Key",
		revision: "r",
		models: [
			{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", toolStreamingVerified: true },
		],
	};
	const catalog = [
		{
			id: "openai/gpt-6.1-sol",
			label: "GPT-6.1 Sol",
			author: "openai",
			created: 0,
		},
	];
	const [viaOpenRouter] = availableConnectionModels(
		[
			{
				...connection,
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
			},
		],
		catalog,
	);
	expect(viaOpenRouter?.speeds).toEqual([
		{ id: "fast", priceMultiple: 2 },
		{ id: "ultrafast", priceMultiple: 6 },
	]);
	const [direct] = availableConnectionModels(
		[
			{
				...connection,
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			},
		],
		catalog,
	);
	expect(direct?.speeds).toBeUndefined();
});

it("lists the Claude 5.2 models with ids that match their routes", () => {
	const anthropic = API_MODEL_LIST.filter(
		(model) => model.author === "anthropic",
	).map((model) => [model.label, model.directId, model.openRouterId]);
	expect(anthropic).toEqual(
		expect.arrayContaining([
			["Claude Fable 5.2", "claude-fable-5-2", "anthropic/claude-fable-5.2"],
			["Claude Mythos 5.2", "claude-mythos-5-2", "anthropic/claude-mythos-5.2"],
		]),
	);
	for (const [, direct, openRouter] of anthropic)
		expect(openRouter).toBe(
			`anthropic/${String(direct).replace(/-(\d)-(\d)$/, "-$1.$2")}`,
		);
});
