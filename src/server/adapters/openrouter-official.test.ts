import { expect, it, vi } from "vitest";
import { openRouterOfficialFetch } from "./openrouter-official";

function sent(fetch: ReturnType<typeof vi.fn>) {
	return JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body));
}

it("pins a listed model to its maker's own providers with fallbacks off", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(fetch)("https://openrouter.ai/api/v1/chat", {
		method: "POST",
		body: JSON.stringify({
			model: "google/gemini-3.8-flash",
			provider: { sort: "price" },
			messages: [],
		}),
	});
	expect(sent(fetch).provider).toEqual({
		sort: "price",
		only: ["google-ai-studio", "google-vertex"],
		allow_fallbacks: false,
	});
});

it("refuses a model that is not on the list before contacting OpenRouter", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await expect(
		openRouterOfficialFetch(fetch)("https://openrouter.ai/api/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "z-ai/glm-5.3-prime", messages: [] }),
		}),
	).rejects.toThrow("not an offered model");
	expect(fetch).not.toHaveBeenCalled();
});

it("pins a faster speed to the maker's own tiered endpoint", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(fetch, "ultrafast")(
		"https://openrouter.ai/api/v1/chat",
		{
			method: "POST",
			body: JSON.stringify({ model: "openai/gpt-6.1-sol", messages: [] }),
		},
	);
	expect(sent(fetch).provider).toEqual({
		only: ["openai/ultrafast"],
		allow_fallbacks: false,
	});
});

it("refuses a speed the model's maker does not offer", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await expect(
		openRouterOfficialFetch(fetch, "ultrafast")(
			"https://openrouter.ai/api/v1/chat",
			{
				method: "POST",
				body: JSON.stringify({ model: "openai/gpt-6-luna", messages: [] }),
			},
		),
	).rejects.toThrow("no ultrafast endpoint");
	expect(fetch).not.toHaveBeenCalled();
});

it("runs DeepSeek only on its approved US hosts with zero retention", async () => {
	const fetch = vi.fn(async () => new Response("{}"));
	await openRouterOfficialFetch(fetch)("https://openrouter.ai/api/v1/chat", {
		method: "POST",
		body: JSON.stringify({
			model: "deepseek/deepseek-v4.1-flash",
			messages: [],
		}),
	});
	expect(sent(fetch).provider).toEqual({
		only: ["fireworks/us", "together"],
		allow_fallbacks: false,
		zdr: true,
	});
});
