import { expect, it } from "vitest";
import { directModelProvider, parseBrowseModels } from "./browse-models";
import { verifiedConnectionModels } from "./model-connection";

const row = (id: string, created = 1) => ({
	id,
	name: `Provider: ${id}`,
	created,
	supported_parameters: ["tools"],
	architecture: { output_modalities: ["text"] },
});
it("groups providers and puts their newest models first without inventing models", () => {
	const models = parseBrowseModels({
		data: [
			row("google/older"),
			row("openai/model"),
			row("google/newer", 2),
			row("google/newer", 2),
			row("google/batch:batch"),
			{ id: "image-only" },
		],
	});
	expect(models.map((model) => model.id)).toEqual([
		"openai/model",
		"google/newer",
		"google/older",
	]);
});
it("ignores malformed and non-tool entries", () => {
	expect(
		parseBrowseModels({
			data: [
				null,
				{},
				{ ...row("google/malformed"), architecture: { output_modalities: {} } },
			],
		}),
	).toEqual([]);
	expect(() => parseBrowseModels({})).toThrow("unavailable");
});
it("keeps subscription access separate from direct API providers", () => {
	expect(directModelProvider("codex")).toBeNull();
	expect(directModelProvider("openai")).toBe("openai");
	expect(directModelProvider("google")).toBe("google");
	expect(directModelProvider("deepseek")).toBe("compatible");
	expect(directModelProvider("unknown")).toBeNull();
});
it("only offers verified models and retains the connection identity", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		verifiedConnectionModels([
			{
				id,
				provider: "openrouter",
				label: "Personal",
				baseUrl: "https://openrouter.ai/api/v1",
				revision: "r",
				models: [
					{ id: "google/model", label: "Model", toolStreamingVerified: true },
					{ id: "not-verified", label: "Other", toolStreamingVerified: false },
				],
			},
		]),
	).toEqual([{ id: `api/${id}/google%2Fmodel`, label: "Model · Personal" }]);
});
