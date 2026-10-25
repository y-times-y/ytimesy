import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { connectedLanguageModel } from "#/server/adapters/api-model";
import { nativeWebSearchTools } from "#/server/adapters/native-web-search";
import { type ModelAgentRuntime, runModelAgentStep } from "./model-agent-loop";
import { webSearchNote, withWebSearchNotes } from "./web-search-notes";

const sources = Array.from({ length: 10 }, (_, index) => ({
	type: "url",
	url: `https://example.com/${index}`,
}));

/** A turn with a hosted search between encrypted reasoning and a function call. */
const history: ModelMessage[] = [
	{ role: "user", content: "Which zstd release added --long?" },
	{
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "",
				providerOptions: {
					openai: { itemId: "rs_1", reasoningEncryptedContent: "gAAAA-enc" },
				},
			},
			{
				type: "tool-call",
				toolCallId: "ws_1",
				toolName: "web_search",
				input: {},
				providerExecuted: true,
			},
			{
				type: "tool-result",
				toolCallId: "ws_1",
				toolName: "web_search",
				output: {
					type: "json",
					value: {
						action: { type: "search", query: "zstd --long release" },
						sources,
					},
				},
			},
			{
				type: "tool-call",
				toolCallId: "call_1",
				toolName: "bash",
				input: { command: "zstd --version" },
			},
		],
	},
	{
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "bash",
				output: { type: "json", value: { status: 0, stdout: "v1.5.7" } },
			},
		],
	},
];

describe("withWebSearchNotes", () => {
	it("writes a hosted search as a note in its place and keeps every other part", () => {
		const [, assistant] = withWebSearchNotes(history);
		expect(assistant.content).toEqual([
			(history[1].content as unknown[])[0],
			{
				type: "text",
				text: `Web search: zstd --long release — sources: ${sources
					.slice(0, 8)
					.map((source) => source.url)
					.join(", ")}, +2 more`,
			},
			(history[1].content as unknown[])[3],
		]);
		expect(withWebSearchNotes(history)[2]).toBe(history[2]);
	});

	it("leaves histories without hosted searches unchanged", () => {
		const plain = [history[0], history[2]];
		expect(withWebSearchNotes(plain)).toEqual(plain);
	});

	it("describes page opens and caps a long note", () => {
		expect(
			webSearchNote({ action: { type: "openPage", url: "https://a.dev/x" } }),
		).toBe("Web search opened https://a.dev/x");
		const long = webSearchNote({
			action: { type: "search", query: "q".repeat(5000) },
		});
		expect(long.length).toBe(1200);
		expect(webSearchNote({})).toBe("Web search: (query not recorded)");
	});
});

describe("store:false Responses request", () => {
	class Captured extends Error {}

	async function requestBody(store: boolean) {
		let body: { input: unknown[] } | undefined;
		const capture: typeof fetch = async (_url, init) => {
			body = JSON.parse(String(init?.body));
			throw new Captured();
		};
		const runtime: ModelAgentRuntime = {
			model: connectedLanguageModel(
				{
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					modelId: "gpt-6.1-sol",
					apiKey: "fixture",
				},
				capture,
			),
			contextWindow: 500_000,
			requestSettings: (instructions) => ({
				providerOptions: {
					openai: {
						instructions,
						store,
						include: ["reasoning.encrypted_content"],
					},
				},
			}),
		};
		await runModelAgentStep(
			{
				userId: "owner",
				modelId: "gpt-6.1-sol",
				toolSurface: "implementation",
				instructions: "Answer.",
				messages: history,
				tools: nativeWebSearchTools("openai"),
				signal: new AbortController().signal,
				onEvent: async () => {},
				onStep: async () => {},
			},
			runtime,
		).catch((error) => {
			if (!body) throw error;
		});
		if (!body) throw new Error("No request was captured.");
		return body;
	}

	it("sends the search as a note and the encrypted reasoning as before", async () => {
		const input = JSON.stringify((await requestBody(false)).input);
		expect(input).toContain("Web search: zstd --long release");
		expect(input).toContain("https://example.com/7");
		expect(input).toContain('"encrypted_content":"gAAAA-enc"');
	});

	it("leaves a stored conversation's item references alone", async () => {
		const input = JSON.stringify((await requestBody(true)).input);
		expect(input).not.toContain("Web search:");
		expect(input).toContain('"item_reference"');
	});
});
