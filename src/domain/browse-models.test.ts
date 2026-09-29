import { expect, it } from "vitest";
import {
	directModelProvider,
	matchesModelSearch,
	openRouterModelLabel,
	parseBrowseModels,
} from "./browse-models";
import { availableConnectionModels } from "./model-connection";

const now = 1_790_000_000;
const row = (id: string, created = now) => ({
	id,
	name: `Provider: ${id}`,
	created,
	supported_parameters: ["tools"],
	architecture: { output_modalities: ["text"] },
});
it("preserves weekly relevance order and excludes old models", () => {
	const models = parseBrowseModels(
		{
			data: [
				row("google/older", now - 366 * 86_400),
				row("openai/model"),
				row("google/newer", now - 20),
				row("google/newer", now - 20),
				row("google/batch:batch"),
				row("~google/alias"),
				{
					...row("openai/audio"),
					architecture: { output_modalities: ["text", "audio"] },
				},
				{ id: "image-only" },
			],
		},
		now,
	);
	expect(models.map((model) => model.id)).toEqual([
		"openai/model",
		"google/newer",
	]);
});
it("searches model names, provider IDs, and provider names", () => {
	const model = { label: "Gemini 3.8 Flash", author: "google" };
	expect(matchesModelSearch(model, "gemini")).toBe(true);
	expect(matchesModelSearch(model, "Google")).toBe(true);
	expect(matchesModelSearch(model, "openai")).toBe(false);
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
it("shows gateway models without repeating the selected provider name", () => {
	expect(openRouterModelLabel("OpenAI: GPT-6 Sol")).toBe("GPT-6 Sol");
	expect(openRouterModelLabel("GPT-6 Sol")).toBe("GPT-6 Sol");
});
it("keeps subscription access separate from direct API providers", () => {
	expect(directModelProvider("codex")).toBeNull();
	expect(directModelProvider("openai")).toBe("openai");
	expect(directModelProvider("google")).toBe("google");
	expect(directModelProvider("deepseek")).toBe("compatible");
	expect(directModelProvider("unknown")).toBeNull();
});
it("offers listed chat models immediately and retains the connection identity", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "openrouter",
					label: "Personal",
					baseUrl: "https://openrouter.ai/api/v1",
					revision: "r",
					models: [
						{
							id: "google/model",
							label: "Google: Model",
							toolStreamingVerified: true,
						},
						{
							id: "not-verified",
							label: "Other",
							toolStreamingVerified: false,
						},
						{
							id: "google/slow:batch",
							label: "Slow batch",
							toolStreamingVerified: false,
						},
					],
				},
			],
			[
				{
					id: "google/model",
					label: "Model",
					author: "google",
					created: now,
				},
			],
		),
	).toEqual([{ id: `api/${id}/google%2Fmodel`, label: "Model · Personal" }]);
});
it("offers new gateway models without reconnecting an existing key", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "openrouter",
					label: "Personal",
					baseUrl: "https://openrouter.ai/api/v1",
					revision: "r",
					models: [],
				},
			],
			[
				{
					id: "z-ai/glm-5.3",
					label: "GLM 5.3",
					author: "z-ai",
					created: now,
				},
			],
		),
	).toEqual([{ id: `api/${id}/z-ai%2Fglm-5.3`, label: "GLM 5.3 · Personal" }]);
});
