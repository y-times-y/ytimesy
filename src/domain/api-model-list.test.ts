import { expect, it } from "vitest";
import { API_MODEL_LIST, apiModelSections } from "./api-model-list";
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
		API_MODEL_LIST.map((model) => `${model.label} · OpenRouter`),
	);
});
