import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	itemsWithVisibleSideChatText,
	sideChatTurnText,
	visibleSideChatText,
} from "./side-chat";

describe("side chat turn text", () => {
	it("strips the ask-only prefix from the visible user question", () => {
		const question = "What did the last command print?";
		expect(visibleSideChatText(sideChatTurnText(question))).toBe(question);
	});

	it("leaves ordinary user text unchanged", () => {
		expect(visibleSideChatText("hello")).toBe("hello");
	});

	it("rewrites prefixed user messages in a side transcript", () => {
		expect(
			itemsWithVisibleSideChatText([
				{
					kind: "userMessage",
					id: SessionItemId("side-1"),
					text: sideChatTurnText("explain the diff"),
				},
			]),
		).toEqual([
			{
				kind: "userMessage",
				id: SessionItemId("side-1"),
				text: "explain the diff",
			},
		]);
	});
});
