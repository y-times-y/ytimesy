import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import {
	compactApiHistory,
	estimateContextTokens,
	modelContextBudget,
} from "./api-agent-context";

it("reserves output, instructions and tools within the selected model's token window", () => {
	const small = modelContextBudget({
		contextWindow: 16_000,
		maxOutputTokens: 4096,
		fixedTokens: 1000,
	});
	const large = modelContextBudget({
		contextWindow: 200_000,
		maxOutputTokens: 4096,
		fixedTokens: 1000,
	});
	expect(small.inputLimitTokens).toBe(10_200);
	expect(large.compactAtTokens).toBeGreaterThan(small.compactAtTokens);
	expect(
		modelContextBudget({
			contextWindow: 200_000,
			autoCompactTokenLimit: 80_000,
		}).compactAtTokens,
	).toBe(80_000);
	expect(estimateContextTokens("你好")).toBeGreaterThan(
		estimateContextTokens("hi"),
	);
});

it("compacts the first long-running turn while retaining its request", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Implement the feature" },
		{ role: "assistant", content: "Investigation ".repeat(8000) },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "Current reasoning",
					providerOptions: { google: { thoughtSignature: "signature" } },
				},
				{ type: "text", text: "Continue" },
			],
		},
	];
	const summarize = vi.fn(
		async () => "Feature is pending; inspected src/main.ts.",
	);
	const result = await compactApiHistory(messages, summarize);
	expect(result.compacted).toBe(true);
	expect(result.messages.slice(1)).toEqual([messages[0], messages[2]]);
	expect(summarize).toHaveBeenCalled();
});

it("retains delegation identities when bounding earlier repository outputs", async () => {
	const pair = (id: string, name: string, value: string): ModelMessage[] => [
		{
			role: "assistant",
			content: [
				{ type: "tool-call", toolCallId: id, toolName: name, input: {} },
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: id,
					toolName: name,
					output: { type: "text", value },
				},
			],
		},
	];
	const messages: ModelMessage[] = [
		{ role: "user", content: "Fix UI" },
		...pair("created", "create_task", "active-child"),
		...pair("large", "read_file", "x".repeat(95000)),
		...pair("last", "read_file", "small"),
		{ role: "assistant", content: "Continue" },
	];
	const summarize = vi.fn(
		async () =>
			"Delegated work to active-child; earlier repository output inspected.",
	);
	const result = await compactApiHistory(messages, summarize);
	expect(JSON.stringify(result.messages)).toContain("active-child");
	expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
	expect(JSON.stringify(summarize.mock.calls)).toContain("x".repeat(95000));
});

it("archives original opaque state before replacing older history and preserves recent signed reasoning", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Old task" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "Earlier decision ".repeat(7000),
					providerOptions: {
						openai: { reasoningEncryptedContent: "opaque-old" },
					},
				},
			],
		},
		{ role: "user", content: "Continue" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: {
						anthropic: {
							redactedData: "opaque-current",
							signature: "signed-current",
						},
					},
				},
			],
		},
	];
	const original = JSON.stringify(messages);
	const summarize = vi.fn(async () => "Earlier decision remains pending.");
	const archive = vi.fn(
		async () => "context-00000000-0000-0000-0000-000000000001",
	);
	const result = await compactApiHistory(
		messages,
		summarize,
		undefined,
		archive,
	);
	expect(archive).toHaveBeenCalledWith(messages);
	expect(JSON.stringify(summarize.mock.calls)).not.toContain("opaque-old");
	expect(JSON.stringify(summarize.mock.calls)).toContain("Earlier decision");
	expect(result.messages.slice(1)).toEqual(messages.slice(2));
	expect(JSON.stringify(result.messages)).toContain("opaque-current");
	expect(JSON.stringify(result.messages)).toContain("context-00000000");
	expect(JSON.stringify(messages)).toBe(original);
	await expect(
		compactApiHistory(messages, summarize, undefined, async () => {
			throw new Error("Storage unavailable");
		}),
	).rejects.toThrow("Storage unavailable");
	expect(JSON.stringify(messages)).toBe(original);
});

it("keeps short conversations unchanged without a summarization call", async () => {
	const messages: ModelMessage[] = [{ role: "user", content: "Fix the test" }];
	const summarize = vi.fn();
	expect(await compactApiHistory(messages, summarize)).toEqual({
		messages,
		compacted: false,
	});
	expect(summarize).not.toHaveBeenCalled();
});

it("never summarizes an unfinished older tool call", async () => {
	const summarize = vi.fn();
	const messages: ModelMessage[] = [
		{ role: "user", content: "Earlier task" },
		{
			role: "assistant",
			content: [
				{ type: "reasoning", text: "x".repeat(95000) },
				{
					type: "tool-call",
					toolCallId: "pending",
					toolName: "bash",
					input: {},
				},
			],
		},
		{ role: "user", content: "New task" },
	];
	await expect(compactApiHistory(messages, summarize)).rejects.toThrow(
		"unfinished tool sequence",
	);
	expect(summarize).not.toHaveBeenCalled();
});

it("summarizes only older turns while retaining recent user requests", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: `Original request ${"a".repeat(36_000)}` },
		{ role: "assistant", content: "Implemented first part" },
		{ role: "user", content: `Second request ${"b".repeat(36_000)}` },
		{ role: "assistant", content: "Investigating" },
		{ role: "user", content: `Current request ${"c".repeat(36_000)}` },
	];
	const summarize = vi.fn(async () => "The first part was implemented.");
	const result = await compactApiHistory(messages, summarize);
	expect(result.compacted).toBe(true);
	expect(summarize).toHaveBeenCalledWith(messages.slice(0, 2));
	expect(result.messages[0]).toMatchObject({ role: "assistant" });
	expect(result.messages.slice(1)).toEqual(messages.slice(2));
});

it("fails instead of silently dropping an oversized current task", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Earlier" },
		{ role: "user", content: "x".repeat(100_000) },
	];
	await expect(compactApiHistory(messages, vi.fn())).rejects.toThrow(
		"Recent task activity exceeds",
	);
});

it("refuses custom prefix replacement beneath active bound reasoning", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Old" },
		{ role: "assistant", content: "x".repeat(95000) },
		{ role: "user", content: "Current" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: { anthropic: { signature: "bound" } },
				},
			],
		},
	];
	const summarize = vi.fn();
	await expect(
		compactApiHistory(
			messages,
			summarize,
			undefined,
			undefined,
			"bound-prefix",
		),
	).rejects.toThrow("bound reasoning");
	expect(summarize).not.toHaveBeenCalled();
});

it("retires only complete older turns for provider-specific fallback", async () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Old" },
		{ role: "assistant", content: "x".repeat(95000) },
		{ role: "user", content: "Current" },
	];
	const result = await compactApiHistory(
		messages,
		async () => "Earlier work complete.",
		undefined,
		undefined,
		"whole-turns",
	);
	expect(result.messages.slice(1)).toEqual([messages[2]]);
});
