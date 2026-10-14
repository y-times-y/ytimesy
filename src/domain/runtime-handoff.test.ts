import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { apiConversation, runtimeHandoffPrompt } from "./api-conversation";
import { SessionItemId } from "./ids";
import {
	modelSwitchHistory,
	providerNeutralHistory,
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

it("drops provider-bound history when a turn switches provider mid-turn", () => {
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
