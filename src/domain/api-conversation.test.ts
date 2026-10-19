import { expect, it } from "vitest";
import {
	apiConversation,
	assertApiContextFits,
	isUserRequestMessage,
	nextTurnMessages,
	runtimeHandoffPrompt,
} from "./api-conversation";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";

it("keeps visible chat history across models without transferring reasoning", () => {
	expect(
		apiConversation([
			{ kind: "userMessage", id: SessionItemId("u"), text: "Fix it" },
			{ kind: "reasoning", id: SessionItemId("r"), summaries: ["private"] },
			{ kind: "agentMessage", id: SessionItemId("a"), text: "Done" },
		]),
	).toEqual([
		{ role: "user", content: "Fix it" },
		{ role: "assistant", content: "Done" },
	]);
});
it("scopes streamed item ids to each turn", () => {
	const first = applyApiProgress([], "one", {
		type: "text-delta",
		id: "same",
		text: "First",
	});
	const second = applyApiProgress(first, "two", {
		type: "text-delta",
		id: "same",
		text: "Second",
	});
	expect(second).toHaveLength(2);
	expect(second[0]).toMatchObject({ text: "First" });
});
it("rejects oversized context without silently truncating instructions", () => {
	expect(() =>
		assertApiContextFits([{ role: "user", content: "x".repeat(8_000_001) }]),
	).toThrow("context");
});

it("recognizes the person's own messages, including handoff-wrapped ones, and not runtime notices", () => {
	const items = [
		{ kind: "userMessage" as const, id: SessionItemId("u1"), text: "Fix it" },
		{
			kind: "userMessage" as const,
			id: SessionItemId("u2"),
			text: "Also add tests",
		},
	];
	expect(isUserRequestMessage(items, { role: "user", content: "Fix it" })).toBe(
		true,
	);
	expect(
		isUserRequestMessage(items, {
			role: "user",
			content: [{ type: "text", text: "Also add tests" }],
		}),
	).toBe(true);
	expect(
		isUserRequestMessage(items, {
			role: "user",
			content: "MCP servers unavailable this turn",
		}),
	).toBe(false);
	expect(
		isUserRequestMessage(items, { role: "assistant", content: "Fix it" }),
	).toBe(false);
});

it("continues structured history after a runtime switch without repeating it in an envelope", () => {
	const transcript = [
		{ kind: "userMessage" as const, id: SessionItemId("u1"), text: "Run it" },
		{ kind: "agentMessage" as const, id: SessionItemId("a1"), text: "Ran it" },
	];
	const items = [
		...transcript,
		{
			kind: "userMessage" as const,
			id: SessionItemId("u2"),
			text: "What did you run last?",
		},
	];
	const handoff = runtimeHandoffPrompt(transcript, "What did you run last?");
	const previous = [
		{ role: "user" as const, content: "Run it" },
		{ role: "assistant" as const, content: "Ran it" },
	];
	const continued = nextTurnMessages({
		previous,
		items,
		text: "What did you run last?",
		runtimeText: "What did you run last?",
		handoff,
	});
	expect(continued).toEqual([
		...previous,
		{ role: "user", content: "What did you run last?" },
	]);
	expect(JSON.stringify(continued)).not.toContain("previous-conversation");
	// Without structured history the envelope is the only carrier of the transcript.
	expect(
		nextTurnMessages({
			previous: null,
			items,
			text: "What did you run last?",
			runtimeText: "What did you run last?",
			handoff,
		}),
	).toEqual([...previous, { role: "user", content: handoff }]);
});

it("sends a runtime replacement text after structured history and in the rebuilt transcript", () => {
	const items = [
		{ kind: "userMessage" as const, id: SessionItemId("u"), text: "visible" },
	];
	expect(
		nextTurnMessages({
			previous: [{ role: "user", content: "earlier" }],
			items,
			text: "visible",
			runtimeText: "peer notice",
		}).at(-1),
	).toEqual({ role: "user", content: "peer notice" });
	expect(
		nextTurnMessages({
			previous: null,
			items,
			text: "visible",
			runtimeText: "peer notice",
		}),
	).toEqual([{ role: "user", content: "peer notice" }]);
});
