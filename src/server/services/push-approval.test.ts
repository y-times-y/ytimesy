import { describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { pushApprovedText } from "#/domain/push-approval";
import type { SessionItem } from "#/domain/session-item";
import {
	approveChatPushRequest,
	PUSH_APPROVAL_UNAVAILABLE,
} from "./push-approval";

vi.mock("../adapters/database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

const requestId = "5b3c9a40-0b5e-4d3a-9a51-2f7d6f1e8c11";
const card: SessionItem = {
	kind: "pushApproval",
	id: SessionItemId("turn:card"),
	requestId,
	repo: "acme/app",
	branch: "main",
	commits: 2,
	summary: "Ship it",
};
const user = (id: string, text = id): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text,
});

function deps(items: unknown, approved = true) {
	return {
		session: vi.fn(async (userId: string) =>
			userId === "alice" ? ({ items } as never) : null,
		),
		approve: vi.fn(async () => approved),
	};
}

describe("approveChatPushRequest", () => {
	it("approves the card's own push request for the chat's owner", async () => {
		const d = deps([user("a"), card]);
		await approveChatPushRequest(
			{ userId: "alice", sessionId: "s", itemId: card.id },
			d,
		);
		expect(d.session).toHaveBeenCalledWith("alice", "s");
		expect(d.approve).toHaveBeenCalledWith("alice", requestId);
	});

	it("refuses another user's chat, a missing or non-push item, and an answered card", async () => {
		const cases: [string, unknown, string][] = [
			["bob", [user("a"), card], card.id],
			["alice", [user("a"), card], "turn:other"],
			["alice", [user("a")], "a"],
			[
				"alice",
				[user("a"), card, user("b", pushApprovedText("main"))],
				card.id,
			],
		];
		for (const [userId, items, itemId] of cases) {
			const d = deps(items);
			await expect(
				approveChatPushRequest({ userId, sessionId: "s", itemId }, d),
			).rejects.toThrow(PUSH_APPROVAL_UNAVAILABLE);
			expect(d.approve).not.toHaveBeenCalled();
		}
	});

	it("says so when the request expired or was already approved", async () => {
		await expect(
			approveChatPushRequest(
				{ userId: "alice", sessionId: "s", itemId: card.id },
				deps([user("a"), card], false),
			),
		).rejects.toThrow(PUSH_APPROVAL_UNAVAILABLE);
	});
});
