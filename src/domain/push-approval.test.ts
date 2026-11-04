import { describe, expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import {
	type PushApprovalRequest,
	pushApprovalOutcome,
	pushApprovalQuestion,
	pushApprovedText,
	pushCancelledText,
	REQUEST_PUSH_APPROVAL_TOOL,
} from "./push-approval";
import type { PushApprovalItem, SessionItem } from "./session-item";
import { chatWaitingOn, chatWaitingOnLabel } from "./sidebar-chats";
import { groupTimelineRows } from "./timeline-activity";

const request: PushApprovalRequest = {
	requestId: "5b3c9a40-0b5e-4d3a-9a51-2f7d6f1e8c11",
	repo: "acme/app",
	branch: "main",
	commits: 3,
	summary: "Fix the login redirect",
};

function called(output: unknown, failed?: boolean) {
	const started = applyApiProgress([], "turn", {
		type: "tool-call",
		id: "call",
		name: REQUEST_PUSH_APPROVAL_TOOL,
		input: { repo: "acme/app", branch: "main", summary: "Fix" },
	});
	expect(started).toEqual([]);
	return applyApiProgress(started, "turn", {
		type: "tool-result",
		id: "call",
		name: REQUEST_PUSH_APPROVAL_TOOL,
		output,
		...(failed ? { failed } : {}),
	});
}

const user = (id: string, text = id): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text,
});
const card: PushApprovalItem = {
	kind: "pushApproval",
	id: SessionItemId("card"),
	...request,
};

describe("request_push_approval in the transcript", () => {
	it("shows an accepted request as a card, without the requested flag", () => {
		expect(called({ requested: true, ...request })).toEqual([
			{ kind: "pushApproval", id: "turn:call", ...request },
		]);
	});

	it("keeps a refused or failed call a tool call", () => {
		for (const items of [
			called({ requested: false, error: "Push first." }),
			called({ requested: true, ...request }, true),
		])
			expect(items).toEqual([
				expect.objectContaining({
					kind: "dynamicToolCall",
					tool: "request_push_approval",
				}),
			]);
	});

	it("asks in one line, counting commits", () => {
		expect(pushApprovalQuestion(request)).toBe(
			"Push 3 commits to main on acme/app?",
		);
		expect(pushApprovalQuestion({ ...request, commits: 1 })).toBe(
			"Push 1 commit to main on acme/app?",
		);
		expect(pushApprovalQuestion({ ...request, commits: null })).toBe(
			"Push these commits to main on acme/app?",
		);
	});

	it("reads the answer from the user's next message", () => {
		expect(pushApprovalOutcome([user("a"), card], card.id)).toBe("pending");
		expect(
			pushApprovalOutcome(
				[user("a"), card, user("b", pushApprovedText("main"))],
				card.id,
			),
		).toBe("approved");
		expect(
			pushApprovalOutcome(
				[user("a"), card, user("b", pushCancelledText("main"))],
				card.id,
			),
		).toBe("cancelled");
		expect(
			pushApprovalOutcome([user("a"), card, user("b", "push it")], card.id),
		).toBe("answered");
		expect(pushApprovalOutcome([user("a")], card.id)).toBe("answered");
	});

	it("marks the chat as needing the user until it is answered", () => {
		expect(chatWaitingOn([user("a"), card], "completed")).toBe("push");
		expect(chatWaitingOn([user("a"), card], "running")).toBe(null);
		expect(
			chatWaitingOn(
				[user("a"), card, user("b", pushApprovedText("main"))],
				"completed",
			),
		).toBe(null);
		expect(chatWaitingOnLabel("push")).toBe("Push waits for your approval");
	});

	it("keeps the card in view with its controls, out of the folded work", () => {
		const rows = groupTimelineRows([user("a"), card], "completed");
		expect(rows).toContainEqual({ kind: "item", item: card });
	});
});
