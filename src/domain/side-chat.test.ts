import { describe, expect, it } from "vitest";
import { offeredAgentProviders } from "./agent-provider";
import { SessionItemId } from "./ids";
import {
	itemsWithVisibleSideChatText,
	sideAgentSubmitLane,
	sideChatComposerAction,
	sideChatTurnText,
	visibleSideChatText,
} from "./side-chat";

describe("side agent isolation", () => {
	it("submits every harness side agent on its own copied checkout", () => {
		for (const provider of offeredAgentProviders()) {
			expect(sideAgentSubmitLane(provider.id)).toBe("main");
		}
	});
});

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

describe("sideChatComposerAction", () => {
	it("stops a running side agent instead of queuing another send", () => {
		expect(sideChatComposerAction("running")).toBe("stop");
		expect(sideChatComposerAction("idle")).toBe("send");
		expect(sideChatComposerAction("completed")).toBe("send");
	});
});
