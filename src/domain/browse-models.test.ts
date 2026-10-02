import { expect, it } from "vitest";
import {
	directModelProvider,
	matchesModelSearch,
	openRouterModelLabel,
	parseBrowseModels,
	recentModelGenerations,
	visibleModelChoices,
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
it("puts recent models first without aging out a retained predecessor", () => {
	const models = parseBrowseModels(
		{
			data: [
				row("google/gemini-3.6-flash", now - 366 * 86_400),
				row("openai/model", now - 30),
				row("google/gemini-3.7-flash", now - 20),
				row("google/gemini-3.7-flash", now - 20),
				row("anthropic/newest"),
				row("google/batch:batch"),
				row("~google/alias"),
				{
					...row("openai/audio"),
					architecture: { output_modalities: ["text", "audio"] },
				},
				row("qwen/qwen3.8-omni-flash"),
				row("mistralai/voxtral-small-24b"),
				row("xiaomi/mimo-v2.6-flash"),
				row("minimax/minimax-m3"),
				row("nvidia/nemotron-3-super"),
				row("tencent/hy4-preview"),
				row("tencent/hy3"),
				{ id: "image-only" },
			],
		},
		now,
	);
	expect(models.map((model) => model.id)).toEqual([
		"anthropic/newest",
		"tencent/hy3",
		"google/gemini-3.7-flash",
		"openai/model",
		"google/gemini-3.6-flash",
	]);
});
it("offers only the selected Google Flash models", () => {
	expect(
		parseBrowseModels({
			data: [
				row("google/gemini-3.8-flash"),
				row("google/gemini-3.7-flash"),
				row("google/gemini-3.6-flash"),
				row("google/gemini-3.1-pro-preview"),
				row("google/gemini-3.8-flash:free"),
			],
		}).map((model) => model.id),
	).toEqual([
		"google/gemini-3.8-flash",
		"google/gemini-3.7-flash",
		"google/gemini-3.6-flash",
	]);
});
it("searches model names, provider IDs, and provider names", () => {
	const model = { label: "Gemini 3.8 Flash", author: "google" };
	expect(matchesModelSearch(model, "gemini")).toBe(true);
	expect(matchesModelSearch(model, "Google")).toBe(true);
	expect(matchesModelSearch(model, "openai")).toBe(false);
});
it("does not hide eligible models behind an arbitrary default-list cap", () => {
	const models = Array.from({ length: 9 }, (_, index) => ({
		label: `Model ${index + 1}`,
		author: "openai",
	}));
	expect(visibleModelChoices(models, "")).toEqual(models);
	expect(visibleModelChoices(models, "Model 9")).toEqual([models[8]]);
	expect(visibleModelChoices(models, "OpenAI")).toHaveLength(9);
});
it("retains the latest three generations and all their variants", () => {
	const ids = [
		"openai/gpt-6.1-sol-pro",
		"openai/gpt-6.1-sol",
		"openai/gpt-6-luna-pro",
		"openai/gpt-6-luna",
		"openai/gpt-6-sol",
		"openai/gpt-6-astra",
		"openai/gpt-5.6-sol",
		"openai/gpt-5.5",
	];
	expect(
		recentModelGenerations(ids.map((id) => ({ id }))).map((m) => m.id),
	).toEqual(ids.slice(0, -1));
});
it("keeps Claude tiers independent, handles older version ordering, and preserves unknown IDs", () => {
	const ids = [
		"anthropic/claude-opus-5.5",
		"anthropic/claude-opus-5",
		"anthropic/claude-opus-4.6",
		"anthropic/claude-opus-4.5",
		"anthropic/claude-sonnet-4.5",
		"anthropic/claude-3-7-sonnet",
		"anthropic/claude-3.5-sonnet",
		"anthropic/claude-3-sonnet",
		"provider/custom",
	];
	expect(
		recentModelGenerations(ids.map((id) => ({ id }))).map((m) => m.id),
	).toEqual(
		ids.filter(
			(id) =>
				!["anthropic/claude-opus-4.5", "anthropic/claude-3-sonnet"].includes(
					id,
				),
		),
	);
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
							id: "google/gemini-3.8-flash",
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
					id: "google/gemini-3.8-flash",
					label: "Model",
					author: "google",
					created: now,
				},
			],
		),
	).toEqual([
		{ id: `api/${id}/google%2Fgemini-3.8-flash`, label: "Model · Personal" },
	]);
});
it("filters saved direct Google connections to the same three models", () => {
	const id = "12345678-1234-4123-8123-123456789012";
	expect(
		availableConnectionModels(
			[
				{
					id,
					provider: "google",
					label: "Google key",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					revision: "r",
					models: [
						{
							id: "gemini-3.6-flash",
							label: "Gemini 3.6 Flash",
							toolStreamingVerified: false,
						},
						{
							id: "gemini-3.8-flash",
							label: "Gemini 3.8 Flash",
							toolStreamingVerified: false,
						},
						{
							id: "gemini-3.1-pro-preview",
							label: "Gemini 3.1 Pro Preview",
							toolStreamingVerified: false,
						},
					],
				},
			],
			[],
		).map((model) => model.label),
	).toEqual(["Gemini 3.8 Flash · Google key", "Gemini 3.6 Flash · Google key"]);
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
