import { describe, expect, it } from "vitest";
import {
	availableConnectionModels,
	connectionModelSpeeds,
	modelConnectionInput,
	modelRouteId,
	officialProviderEndpoint,
	parseModelRouteId,
	publicModelEndpoint,
} from "./model-connection";

describe("model connections", () => {
	it.each([
		"http://example.com/v1",
		"https://user:secret@example.com",
		"https://example.com?key=secret",
		"https://example.com#secret",
		"https://example.com:8443",
	])("rejects unsafe endpoint syntax %s", (value) => {
		expect(() => publicModelEndpoint(value)).toThrow();
	});
	it("normalizes URLs and prevents overriding native endpoints", () => {
		expect(publicModelEndpoint("https://example.com/v1/")).toBe(
			"https://example.com/v1",
		);
		expect(
			modelConnectionInput.parse({
				provider: "openai",
				label: "Work",
				apiKey: "fixture-key",
				baseUrl: "https://elsewhere.example",
			}).baseUrl,
		).toBe("https://api.openai.com/v1");
	});
	it("round trips provider model IDs without mixing connections", () => {
		const connectionId = "12345678-1234-4123-8123-123456789012";
		expect(
			parseModelRouteId(modelRouteId(connectionId, "vendor/model:version")),
		).toEqual({ connectionId, modelId: "vendor/model:version" });
		expect(parseModelRouteId("api/wrong/model")).toBeNull();
		expect(parseModelRouteId(`api/${connectionId}/%xx`)).toBeNull();
	});
});

describe("officialProviderEndpoint", () => {
	it("accepts only the provider's own API origin", () => {
		expect(
			officialProviderEndpoint({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		).toBe(true);
		expect(
			officialProviderEndpoint({
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
			}),
		).toBe(true);
		expect(
			officialProviderEndpoint({
				provider: "openai",
				baseUrl: "https://proxy.example.com/v1",
			}),
		).toBe(false);
		expect(
			officialProviderEndpoint({
				provider: "compatible",
				baseUrl: "https://api.openai.com/v1",
			}),
		).toBe(false);
		expect(
			officialProviderEndpoint({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		).toBe(true);
	});
});

describe("connection model speeds", () => {
	const xai = {
		provider: "compatible" as const,
		baseUrl: "https://api.x.ai/v1",
	};

	it("offers xAI's priority tier on its own API, as 2x price", () => {
		expect(connectionModelSpeeds(xai, "grok-4.7")).toEqual([
			{
				id: "fast",
				providers: ["xai/priority"],
				priceMultiple: 2,
				serviceTier: "priority",
			},
		]);
		expect(connectionModelSpeeds(xai, "grok-4.6")[0]?.serviceTier).toBe(
			"priority",
		);
		expect(connectionModelSpeeds(xai, "grok-4.20-0309-reasoning")).toEqual([]);
	});

	it("offers no direct speed elsewhere, and OpenRouter's as before", () => {
		expect(
			connectionModelSpeeds(
				{ provider: "compatible", baseUrl: "https://gateway.example/v1" },
				"grok-4.7",
			),
		).toEqual([]);
		expect(
			connectionModelSpeeds(
				{ provider: "openai", baseUrl: "https://api.openai.com/v1" },
				"gpt-6.1-sol",
			),
		).toEqual([]);
		expect(
			connectionModelSpeeds(
				{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
				"x-ai/grok-4.7",
			)[0]?.providers,
		).toEqual(["xai/priority"]);
	});

	it("lists Fast on the Grok plan's models in the picker", () => {
		const [model] = availableConnectionModels(
			[
				{
					id: "11111111-1111-4111-8111-111111111111",
					provider: "compatible",
					label: "Grok plan",
					baseUrl: "https://api.x.ai/v1",
					models: [
						{ id: "grok-4.7", label: "grok-4.7", toolStreamingVerified: true },
					],
					revision: "r1",
					subscription: { provider: "xai", status: "ready" },
				},
			],
			[],
		);
		expect(model?.speeds).toEqual([{ id: "fast", priceMultiple: 2 }]);
	});
});
