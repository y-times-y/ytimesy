import { expect, it, vi } from "vitest";
import {
	discoverConnectionModels,
	parseConnectedModels,
} from "./model-catalog";

it("deduplicates model IDs without claiming tool support", () => {
	expect(
		parseConnectedModels("openrouter", {
			data: [
				{ id: "vendor/code", name: "Code" },
				{ id: "vendor/code", name: "Code" },
				{ id: 42 },
			],
		}),
	).toEqual([
		{ id: "vendor/code", label: "Code", toolStreamingVerified: false },
	]);
});
it("filters Google embedding-only models", () => {
	expect(
		parseConnectedModels("google", {
			models: [
				{
					name: "models/chat",
					displayName: "Chat",
					supportedGenerationMethods: ["generateContent"],
				},
				{ name: "models/embed", supportedGenerationMethods: ["embedContent"] },
			],
		}),
	).toEqual([{ id: "chat", label: "Chat", toolStreamingVerified: false }]);
});
it("follows pagination and authenticates using the provider header", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(
			Response.json({
				data: [{ id: "first" }],
				has_more: true,
				last_id: "first",
			}),
		)
		.mockResolvedValueOnce(
			Response.json({ data: [{ id: "second" }], has_more: false }),
		);
	const result = await discoverConnectionModels(
		{
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			apiKey: "fixture-key",
		},
		fetch,
	);
	expect(result.map((row) => row.id)).toEqual(["first", "second"]);
	expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
		"x-api-key": "fixture-key",
	});
	expect(String(fetch.mock.calls[1][0])).toContain("after_id=first");
});
it("does not expose provider errors that might echo credentials", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(new Response("secret-key-fixture", { status: 401 }));
	await expect(
		discoverConnectionModels(
			{
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "secret-key-fixture",
			},
			fetch,
		),
	).rejects.toThrow("HTTP 401");
});
