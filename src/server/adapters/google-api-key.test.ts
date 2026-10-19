import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { publicToolDetail } from "#/domain/tool-detail";
import { connectedLanguageModel } from "./api-model";
import { discoverConnectionModels } from "./model-catalog";
import { readModelContext } from "./model-context";

// Google issues two API key formats: the classic `AIza…` keys and newer `AQ.…`
// keys. Measured live on 2026-10-18 with an AQ. key: models list/get,
// generateContent and streamGenerateContent all accept it in the
// x-goog-api-key header (the same as `?key=`); a 404 came only from a model id
// the project does not have. Every Google call therefore sends the key in the
// header and never in the URL, where an error's url field or a request log
// would carry it.
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const KEYS = {
	classic: `AIza${"x".repeat(35)}`,
	aq: `AQ.${"Ab1_-".repeat(10)}`,
};

type Seen = { url: string; key: string | null };

function recorder(body: (url: string) => unknown) {
	const seen: Seen[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		seen.push({ url, key: new Headers(init?.headers).get("x-goog-api-key") });
		return Response.json(body(url));
	};
	return { seen, fetch };
}

describe.each(Object.entries(KEYS))("Google %s keys", (_kind, apiKey) => {
	it("generateContent sends the key in the header, not the URL", async () => {
		const { seen, fetch } = recorder(() => ({
			candidates: [
				{
					content: { role: "model", parts: [{ text: "ok" }] },
					finishReason: "STOP",
				},
			],
			usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
		}));
		const model = connectedLanguageModel(
			{
				provider: "google",
				baseUrl: BASE,
				apiKey,
				modelId: "gemini-3.8-flash",
			},
			fetch,
		);
		const result = await generateText({ model, prompt: "Say ok" });
		expect(result.text).toBe("ok");
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe(`${BASE}/models/gemini-3.8-flash:generateContent`);
		expect(seen[0].key).toBe(apiKey);
	});

	it("model discovery and context lookup send it the same way", async () => {
		const { seen, fetch } = recorder((url) =>
			url.includes("/models/")
				? { name: "models/gemini-3.8-flash", inputTokenLimit: 1_048_576 }
				: {
						models: [
							{
								name: "models/gemini-3.8-flash",
								displayName: "Gemini 3.8 Flash",
								inputTokenLimit: 1_048_576,
								supportedGenerationMethods: ["generateContent"],
							},
						],
					},
		);
		const models = await discoverConnectionModels(
			{ provider: "google", baseUrl: BASE, apiKey },
			fetch,
		);
		expect(models.map((model) => model.id)).toContain("gemini-3.8-flash");
		const context = await readModelContext(
			{
				provider: "google",
				baseUrl: BASE,
				apiKey,
				modelId: "gemini-3.8-flash",
				cacheKey: `google-key-test-${apiKey.slice(0, 4)}`,
			},
			fetch,
		);
		expect(context.contextWindow).toBe(1_048_576);
		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const request of seen) {
			expect(request.key).toBe(apiKey);
			expect(request.url).not.toContain(apiKey);
			expect(new URL(request.url).searchParams.has("key")).toBe(false);
		}
	});

	it("is redacted from tool output", () => {
		const shown = publicToolDetail(`GEMINI=${apiKey} curl -s ...?k=${apiKey}`);
		expect(shown).not.toContain(apiKey);
	});
});
