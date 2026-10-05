import { expect, it, vi } from "vitest";
import { readModelContext } from "./model-context";

it("only enables Claude native compaction from owner-authenticated advertised capability", async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			max_input_tokens: 200_000,
			capabilities: { compaction: { supported: true } },
		}),
	);
	const input = {
		provider: "anthropic" as const,
		baseUrl: "https://api.anthropic.com/v1",
		apiKey: "fixture-key",
		modelId: "claude-fixture",
		cacheKey: "owner-a/native",
	};
	expect(await readModelContext(input, fetch)).toEqual({
		contextWindow: 200_000,
		nativeCompaction: "anthropic",
	});
	expect(fetch.mock.calls[0]).toBeDefined();
	await readModelContext(input, fetch);
	expect(fetch).toHaveBeenCalledTimes(1);
	await readModelContext({ ...input, cacheKey: "owner-b/native" }, fetch);
	expect(fetch).toHaveBeenCalledTimes(2);
});

it("uses provider context metadata without treating context editing as signed on-demand compaction", async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			max_input_tokens: 100_000,
			capabilities: { context_management: { supported: true } },
		}),
	);
	expect(
		await readModelContext(
			{
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				apiKey: "fixture",
				modelId: "old-model",
				cacheKey: "context-only",
			},
			fetch,
		),
	).toEqual({ contextWindow: 100_000, nativeCompaction: undefined });
});

it("does not send credentials to metadata paths on custom compatible endpoints", async () => {
	const fetch = vi.fn();
	expect(
		await readModelContext(
			{
				provider: "compatible",
				baseUrl: "https://custom.example/v1",
				apiKey: "fixture",
				modelId: "gpt-6-fixture",
				cacheKey: "custom",
				contextWindow: 16_000,
			},
			fetch,
		),
	).toEqual({ contextWindow: 16_000, nativeCompaction: undefined });
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	["openai", "https://api.openai.com/v1", "gpt-5.4", "openai-endpoint"],
	["compatible", "https://api.x.ai/v1", "grok-4.7", "xai"],
	["compatible", "https://api.x.ai/v1", "grok-4.6", undefined],
	["compatible", "https://custom.example/v1", "grok-4.7", undefined],
] as const)(
	"selects only documented official compact routes: %s %s %s",
	async (provider, baseUrl, modelId, nativeCompaction) => {
		const context = await readModelContext(
			{
				provider,
				baseUrl,
				modelId,
				apiKey: "fixture",
				contextWindow: 100_000,
				cacheKey: `${baseUrl}/${modelId}/compact-proof`,
			},
			vi.fn(),
		);
		expect(context.nativeCompaction).toBe(nativeCompaction);
	},
);
