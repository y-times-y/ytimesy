import { type ModelMessage, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it, vi } from "vitest";
import { archiveConsumedGuidance } from "./consumed-guidance";
import { runModelAgentStep } from "./model-agent-loop";

function history(nextStart: number | null = null): ModelMessage[] {
	return [
		{ role: "user", content: "Implement the requested change" },
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "guidance",
					toolName: "read_repository_guidance",
					input: { scope: "src" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "guidance",
					toolName: "read_repository_guidance",
					output: {
						type: "json",
						value: {
							revision: "revision",
							instructions: [
								{ path: "AGENTS.md", content: "Follow every requirement" },
							],
							referencedDocuments: [
								{
									path: "PLAN.md",
									sha256: "hash",
									content: "🙂".repeat(20000),
									nextStart,
								},
							],
							configuration: [
								{ path: "package.json", content: "required checks" },
							],
						},
					},
				},
			],
		},
	];
}

function implemented(messages: ModelMessage[]) {
	messages.push(
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "edit",
					toolName: "apply_patches",
					input: { operations: [] },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "edit",
					toolName: "apply_patches",
					output: { type: "json", value: { changed: ["module.ts"] } },
				},
			],
		},
	);
}

it("keeps newly returned guidance complete until a later assistant has observed it", async () => {
	const messages = history();
	const archive = vi.fn();
	expect(await archiveConsumedGuidance(messages, archive)).toBe(messages);
	expect(archive).not.toHaveBeenCalled();
});

it("archives after the first completed implementation decision, before another inference replays the body", async () => {
	const messages = history();
	implemented(messages);
	const archive = vi.fn().mockResolvedValue("context-reference");
	const projected = await archiveConsumedGuidance(messages, archive);
	expect(archive).toHaveBeenCalledExactlyOnceWith(messages);
	expect(JSON.stringify(projected)).not.toContain("🙂");
	expect(projected.at(-1)).toBe(messages.at(-1));
});

it("archives consumed complete bodies while preserving instructions, metadata and signed reasoning", async () => {
	const messages = history();
	const reasoning: ModelMessage = {
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "",
				providerOptions: { openai: { encryptedContent: "opaque-exact" } },
			},
		],
	};
	implemented(messages);
	messages.push(reasoning);
	const original = structuredClone(messages);
	const archive = vi.fn().mockResolvedValue("context-reference");
	const projected = await archiveConsumedGuidance(messages, archive);
	expect(archive).toHaveBeenCalledExactlyOnceWith(messages);
	expect(messages).toEqual(original);
	expect(projected.at(-1)).toBe(reasoning);
	const tool = projected[2];
	if (tool.role !== "tool" || tool.content[0].type !== "tool-result")
		throw new Error("Missing tool receipt");
	expect(tool.content[0].output).toMatchObject({
		type: "json",
		value: {
			revision: "revision",
			instructions: [
				{ path: "AGENTS.md", content: "Follow every requirement" },
			],
			configuration: [{ path: "package.json", content: "required checks" }],
			referencedDocuments: [
				{
					path: "PLAN.md",
					sha256: "hash",
					nextStart: null,
					archivedBody: {
						reference: "context-reference",
						messageIndex: 2,
						toolCallId: "guidance",
						characters: 20000,
					},
				},
			],
		},
	});
	expect(JSON.stringify(projected)).not.toContain("🙂");
	expect(await archiveConsumedGuidance(projected, archive)).toBe(projected);
	expect(archive).toHaveBeenCalledTimes(1);
});

it("never archives incomplete documents or drops text without a durable archive", async () => {
	const messages = history(20000);
	implemented(messages);
	messages.push({ role: "assistant", content: "Need the remaining page" });
	const archive = vi.fn();
	expect(await archiveConsumedGuidance(messages, archive)).toBe(messages);
	expect(archive).not.toHaveBeenCalled();
	expect(await archiveConsumedGuidance(messages)).toBe(messages);
});

it("fails before projection if durable archival fails and leaves the original untouched", async () => {
	const messages = history();
	implemented(messages);
	messages.push({ role: "assistant", content: "Observed guidance" });
	const original = structuredClone(messages);
	await expect(
		archiveConsumedGuidance(
			messages,
			vi.fn().mockRejectedValue(new Error("Storage unavailable")),
		),
	).rejects.toThrow("Storage unavailable");
	expect(messages).toEqual(original);
});

it("checkpoints the recoverable projection before inference and preserves native reasoning in replay", async () => {
	const messages = history();
	implemented(messages);
	messages.push({
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "",
				providerOptions: { openai: { encryptedContent: "opaque-exact" } },
			},
			{ type: "text", text: "Observed complete guidance" },
		],
	});
	const order: string[] = [];
	const model = new MockLanguageModelV4({
		doStream: async () => {
			order.push("inference");
			return {
				stream: simulateReadableStream({
					initialDelayInMs: null,
					chunkDelayInMs: null,
					chunks: [
						{ type: "text-start", id: "answer" },
						{ type: "text-delta", id: "answer", delta: "Done" },
						{ type: "text-end", id: "answer" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 3,
									noCache: 3,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						},
					],
				}),
			};
		},
	});
	await runModelAgentStep(
		{
			userId: "alice",
			modelId: "fixture",
			messages,
			instructions: "Follow repository rules",
			tools: {},
			signal: new AbortController().signal,
			archiveHistory: async () => {
				order.push("archive");
				return "context-reference";
			},
			onStep: async () => {
				order.push("checkpoint");
			},
			onEvent: async () => {},
		},
		{ model, contextWindow: 128000, archiveConsumedGuidance: true },
	);
	expect(order.slice(0, 3)).toEqual(["archive", "checkpoint", "inference"]);
	const replay = JSON.stringify(model.doStreamCalls[0].prompt);
	expect(replay).toContain("context-reference");
	expect(replay).toContain("opaque-exact");
	expect(replay).toContain("Follow every requirement");
	expect(replay).not.toContain("🙂");
});

it("keeps guidance through preflight source inspection before any implementation decision", async () => {
	const messages = history();
	messages.push({
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolName: "read_files",
				toolCallId: "source",
				input: { paths: ["source.ts"] },
			},
		],
	});
	const archive = vi.fn();
	expect(await archiveConsumedGuidance(messages, archive)).toBe(messages);
	expect(archive).not.toHaveBeenCalled();
});
