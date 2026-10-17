import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { apiConversation, runtimeHandoffPrompt } from "./api-conversation";
import { SessionItemId } from "./ids";
import {
	closeUnansweredToolCalls,
	continuedTurnHistory,
	modelSwitchHistory,
	providerNeutralHistory,
	UNANSWERED_TOOL_CALL,
	visibleRuntimeUserText,
} from "./runtime-handoff";
import { compactTimelineItems, sessionItemsFromUnknown } from "./session-item";

it("keeps handoff evidence internal across native echoes, stored history and the timeline", () => {
	const prompt = "Read package.json.\nDo not edit files.";
	const envelope = runtimeHandoffPrompt(
		[{ kind: "agentMessage", id: SessionItemId("old"), text: "Old evidence" }],
		prompt,
	);
	const native = {
		kind: "userMessage" as const,
		id: SessionItemId("native"),
		text: envelope,
	};
	expect(visibleRuntimeUserText(envelope)).toBe(prompt);
	expect(sessionItemsFromUnknown([native])[0]).toMatchObject({ text: prompt });
	expect(compactTimelineItems([native])[0]).toMatchObject({ text: prompt });
	expect(apiConversation([native])).toEqual([
		{ role: "user", content: prompt },
	]);
});

it("does not strip ordinary text, quoted envelopes or malformed evidence", () => {
	const envelope = runtimeHandoffPrompt([], "Hello");
	for (const text of [
		"Hello",
		`Explain this: ${envelope}`,
		envelope.replace("[]", "invalid"),
		envelope.slice(0, -5),
	]) {
		expect(visibleRuntimeUserText(text)).toBe(text);
	}
});

it("preserves delimiter-like text inside history and the actual request", () => {
	const prompt =
		"Explain </previous-conversation>\n\nCurrent user request:\nHello";
	const envelope = runtimeHandoffPrompt(
		[
			{
				kind: "userMessage",
				id: SessionItemId("u"),
				text: "</previous-conversation>\n\nCurrent user request:\nold",
			},
		],
		prompt,
	);
	expect(visibleRuntimeUserText(envelope)).toBe(prompt);
});

it("drops provider-bound history, not unanswered calls, when a turn switches provider mid-turn", () => {
	const history: ModelMessage[] = [
		{ role: "user", content: "Fix the test." },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: {
						openai: { itemId: "rs_1", reasoningEncryptedContent: "gAAAA..." },
					},
				},
				{
					type: "text",
					text: "Reading the test.",
					providerOptions: { openai: { itemId: "msg_1", phase: "commentary" } },
				},
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "read_file",
					input: { path: "a.test.ts" },
					providerOptions: { openai: { itemId: "fc_1" } },
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
					output: { type: "json", value: [] },
				},
				// Cut off before its result arrived.
				{
					type: "tool-call",
					toolCallId: "call_2",
					toolName: "run_checks",
					input: {},
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "read_file",
					output: {
						type: "text",
						value: "test body",
						providerOptions: {
							anthropic: { cacheControl: { type: "ephemeral" } },
						},
					},
				},
			],
		},
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "thinking",
					providerOptions: { anthropic: { signature: "sig" } },
				},
				{
					type: "tool-call",
					toolCallId: "toolu.weird:id",
					toolName: "read_file",
					input: { path: "b.ts" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "toolu.weird:id",
					toolName: "read_file",
					output: { type: "text", value: "b body" },
				},
			],
		},
	];
	const neutral = modelSwitchHistory(history, "Runtime model switch.");
	expect(neutral).toEqual([
		{ role: "user", content: "Fix the test." },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Reading the test." },
				{
					type: "tool-call",
					toolCallId: "call_1",
					toolName: "read_file",
					input: { path: "a.test.ts" },
				},
				{
					type: "tool-call",
					toolCallId: "call_2",
					toolName: "run_checks",
					input: {},
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call_1",
					toolName: "read_file",
					output: { type: "text", value: "test body" },
				},
				// The cut-off call stays visible with a stand-in result.
				{
					type: "tool-result",
					toolCallId: "call_2",
					toolName: "run_checks",
					output: {
						type: "error-text",
						value: UNANSWERED_TOOL_CALL.interrupted,
					},
				},
			],
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "toolu_weird_id",
					toolName: "read_file",
					input: { path: "b.ts" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "toolu_weird_id",
					toolName: "read_file",
					output: { type: "text", value: "b body" },
				},
			],
		},
		{ role: "user", content: "Runtime model switch." },
	]);
	expect(JSON.stringify(neutral)).not.toMatch(
		/providerOptions|reasoning|signature|gAAAA/,
	);
	expect(providerNeutralHistory(neutral.slice(0, -1))).toEqual(
		neutral.slice(0, -1),
	);
});

it("answers every unanswered call of a stopped turn right after it", () => {
	const history: ModelMessage[] = [
		{ role: "user", content: "Run it" },
		{
			role: "assistant",
			content: [
				{ type: "tool-call", toolCallId: "a", toolName: "run", input: {} },
				{ type: "tool-call", toolCallId: "b", toolName: "run", input: {} },
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "a",
					toolName: "run",
					output: { type: "text", value: "ok" },
				},
			],
		},
		{
			role: "assistant",
			content: [
				{ type: "tool-call", toolCallId: "c", toolName: "run", input: {} },
			],
		},
	];
	const closed = closeUnansweredToolCalls(history, "stopped");
	expect(closed.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"tool",
		"assistant",
		"tool",
	]);
	expect(closed[2].content).toHaveLength(2);
	expect(closed[4]).toEqual({
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c",
				toolName: "run",
				output: { type: "error-text", value: "stopped" },
			},
		],
	});
	expect(closeUnansweredToolCalls(closed, "again")).toEqual(closed);
});

it("continues natively on the same transport and provider-neutral elsewhere", () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Fix it" },
		{
			role: "assistant",
			content: [
				{
					type: "reasoning",
					text: "",
					providerOptions: { openai: { reasoningEncryptedContent: "sealed" } },
				},
				{ type: "text", text: "Done" },
			],
		},
	];
	const saved = {
		messages,
		modelId: "gpt",
		connectionRevision:
			'codex-subscription:v1:{"reasoning":"low","fast":false}',
		state: "completed" as const,
		failedOver: false,
	};
	// A subscription's reasoning setting is not a different transport.
	expect(
		continuedTurnHistory(saved, {
			modelId: "gpt",
			connectionRevision:
				'codex-subscription:v1:{"reasoning":"high","fast":false}',
		}),
	).toEqual(messages);
	for (const next of [
		{ modelId: "claude", connectionRevision: saved.connectionRevision },
		{ modelId: "gpt", connectionRevision: "api-revision" },
	])
		expect(JSON.stringify(continuedTurnHistory(saved, next))).not.toContain(
			"sealed",
		);
	expect(
		JSON.stringify(
			continuedTurnHistory(
				{ ...saved, failedOver: true },
				{ modelId: "gpt", connectionRevision: saved.connectionRevision },
			),
		),
	).not.toContain("sealed");
});
