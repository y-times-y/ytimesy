import { generateText } from "ai";
import { expect, it, vi } from "vitest";
import { connectedLanguageModel } from "./api-model";

it("roundtrips encrypted OpenRouter details through a serialized checkpoint and the real SDK converter", async () => {
	const details = [
		{
			type: "reasoning.encrypted",
			id: "rs-one",
			data: "opaque-state",
			format: "openai-responses-v1",
			index: 0,
		},
	];
	const fetch = vi.fn(
		async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
			Response.json({
				id: "fixture",
				model: "openai/gpt-6-sol",
				choices: [
					{
						index: 0,
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: "Done",
							reasoning_details: details,
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			}),
	);
	const model = connectedLanguageModel(
		{
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "fixture",
			modelId: "openai/gpt-6-sol",
		},
		fetch,
	);
	const first = await generateText({ model, prompt: "Task", maxRetries: 0 });
	await generateText({
		model,
		messages: [
			{ role: "user", content: "Task" },
			...JSON.parse(JSON.stringify(first.response.messages)),
			{ role: "user", content: "Continue" },
		],
		maxRetries: 0,
	});
	const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
	expect(
		body.messages.find(
			(message: { role: string }) => message.role === "assistant",
		).reasoning_details,
	).toEqual(details);
});

it("replays DeepSeek V4 reasoning from earlier user turns using its maintained adapter", async () => {
	const fetch = vi.fn(
		async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
			Response.json({
				id: "fixture",
				object: "chat.completion",
				created: 1,
				model: "deepseek-flash",
				choices: [
					{
						index: 0,
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: "Done",
							reasoning_content: "Reasoning",
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			}),
	);
	const model = connectedLanguageModel(
		{
			provider: "compatible",
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "fixture",
			modelId: "deepseek-flash",
		},
		fetch,
	);
	await generateText({
		model,
		messages: [
			{ role: "user", content: "First" },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "Earlier thought" },
					{ type: "text", text: "Earlier answer" },
				],
			},
			{ role: "user", content: "Next" },
		],
		maxRetries: 0,
	});
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
	expect(body.messages[1].reasoning_content).toBe("Earlier thought");
});

it("rejects a gateway format the installed SDK would silently drop", async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			choices: [
				{
					message: {
						reasoning_details: [
							{
								type: "reasoning.encrypted",
								format: "future-provider-v2",
								data: "opaque",
							},
						],
					},
				},
			],
		}),
	);
	const model = connectedLanguageModel(
		{
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "fixture",
			modelId: "fixture-model",
		},
		fetch,
	);
	await expect(
		generateText({ model, prompt: "Task", maxRetries: 0 }),
	).rejects.toThrow("Unsupported OpenRouter reasoning protocol");
});
