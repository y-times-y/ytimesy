import { expect, it } from "vitest";
import { chatForIssue, issueNumberFromChatTitle } from "./github-issues";

it("reads the issue a chat was started for from its title", () => {
	expect(issueNumberFromChatTitle("Issue #42: Selection disappears")).toBe(42);
	expect(issueNumberFromChatTitle("Review PR #42")).toBeNull();
	expect(issueNumberFromChatTitle("My own name for it")).toBeNull();
});

it("finds the chat through a pull request that closes the issue, else by title", () => {
	const byHead = new Map([["fix/selection", "chat-on-pr"]]);
	const byIssue = new Map([[42, "chat-by-title"]]);
	const open = { number: 7, state: "open" as const, head: "fix/selection" };
	expect(
		chatForIssue({ pullRequests: [open], byHead, byIssue, number: 42 }),
	).toBe("chat-on-pr");
	expect(
		chatForIssue({
			pullRequests: [{ ...open, head: "other" }],
			byHead,
			byIssue,
			number: 42,
		}),
	).toBe("chat-by-title");
	expect(
		chatForIssue({ pullRequests: undefined, byHead, byIssue, number: 42 }),
	).toBe("chat-by-title");
	expect(
		chatForIssue({ pullRequests: [], byHead, byIssue, number: 43 }),
	).toBeUndefined();
});
