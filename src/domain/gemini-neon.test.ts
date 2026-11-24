import { describe, expect, it } from "vitest";
import { OFFERED_API_MODELS } from "./api-model-list";
import { listedModelDisplayName } from "./listed-model";
import {
	availableConnectionModels,
	connectionModelSpeeds,
	type PublicModelConnection,
} from "./model-connection";
import { knownModelLimits } from "./model-context-windows";
import { canonicalModelId, modelTier } from "./model-failover";
import { modelPrice } from "./model-pricing";
import { isRetiredModel } from "./retired-model";

const saved = (id: string) => ({
	id,
	label: id,
	toolStreamingVerified: false,
});
const google = (ids: string[]): PublicModelConnection => ({
	id: "12345678-1234-4123-8123-123456789012",
	provider: "google",
	label: "Google key",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	models: ids.map(saved),
	revision: "1",
});

describe("Gemini 4 Neon", () => {
	it("is offered and not retired", () => {
		expect(OFFERED_API_MODELS.some((m) => m.directId === "gemini-4-neon")).toBe(
			true,
		);
		expect(isRetiredModel("gemini-4-neon")).toBe(false);
		expect(listedModelDisplayName("gemini-4-neon")).toBeDefined();
	});
	it("is listed only on a Google connection that has it", () => {
		expect(
			availableConnectionModels([google(["gemini-4-neon"])], []).map(
				(m) => m.label,
			),
		).toEqual(["Gemini 4 Neon · Google key"]);
		expect(
			availableConnectionModels([google(["gemini-4-argon"])], []).map(
				(m) => m.label,
			),
		).toEqual(["Gemini 4 Argon · Google key"]);
		const openai: PublicModelConnection = {
			...google(["gemini-4-neon"]),
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		expect(availableConnectionModels([openai], [])).toEqual([]);
	});
	it("resolves pricing, context window and the priority speed", () => {
		expect(modelPrice("google/gemini-4-neon", Date.now())).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.15,
		});
		expect(knownModelLimits("gemini-4-neon")).toMatchObject({
			contextWindow: 1_048_576,
			imageInput: true,
		});
		expect(knownModelLimits("google/gemini-4-neon")?.contextWindow).toBe(
			1_048_576,
		);
		const openrouter = {
			provider: "openrouter" as const,
			baseUrl: "https://openrouter.ai/api/v1",
		};
		expect(
			connectionModelSpeeds(openrouter, "google/gemini-4-neon").map(
				(s) => s.priceMultiple,
			),
		).toEqual([1.8]);
	});
	it("fails over with the other frontier models", () => {
		expect(modelTier("google/gemini-4-neon")).toBe("frontier");
		expect(
			canonicalModelId(
				{
					kind: "key",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				},
				"gemini-4-neon",
			),
		).toBe("google/gemini-4-neon");
	});
});
