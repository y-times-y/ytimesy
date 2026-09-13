import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	fileChangesFromSessionItems,
	isConversationItem,
	isTurnRunning,
	lastUserMessageText,
	type SessionItem,
	visibleSessionItems,
} from "./session-item";

describe("session items", () => {
	it("keeps user and agent text separate from tool activity", () => {
		const user: SessionItem = {
			kind: "userMessage",
			id: SessionItemId("user-1"),
			text: "run echo",
		};
		const command: SessionItem = {
			kind: "commandExecution",
			id: SessionItemId("cmd-1"),
			command: "echo hi",
			cwd: "/tmp",
			status: "completed",
			output: "hi\n",
			exitCode: 0,
		};

		expect(isConversationItem(user)).toBe(true);
		expect(isConversationItem(command)).toBe(false);
	});

	it("does not treat a completed turn as still running", () => {
		expect(isTurnRunning("running")).toBe(true);
		expect(isTurnRunning("completed")).toBe(false);
		expect(isTurnRunning("idle")).toBe(false);
	});

	it("collects file paths only from fileChange items", () => {
		const items: SessionItem[] = [
			{
				kind: "agentMessage",
				id: SessionItemId("msg-1"),
				text: "edited README",
			},
			{
				kind: "fileChange",
				id: SessionItemId("patch-1"),
				status: "completed",
				changes: [
					{ path: "README.md", change: "update", additions: 4, deletions: 1 },
					{ path: "src/app.ts", change: "add", additions: 12, deletions: 0 },
				],
			},
		];

		expect(fileChangesFromSessionItems(items)).toEqual([
			{ path: "README.md", change: "update", additions: 4, deletions: 1 },
			{ path: "src/app.ts", change: "add", additions: 12, deletions: 0 },
		]);
	});

	it("keeps a local user message until the server transcript includes it", () => {
		const server: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("user-1"),
				text: "first",
			},
		];
		const optimistic: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("local-2"),
				text: "second",
			},
		];

		expect(visibleSessionItems(server, optimistic)).toHaveLength(2);
		expect(
			visibleSessionItems(server, [
				{ kind: "userMessage", id: SessionItemId("local-1"), text: "first" },
			]),
		).toEqual(server);
	});

	it("returns the most recent user message for retry", () => {
		const items: SessionItem[] = [
			{
				kind: "userMessage",
				id: SessionItemId("user-1"),
				text: "first",
			},
			{
				kind: "agentMessage",
				id: SessionItemId("msg-1"),
				text: "ok",
			},
			{
				kind: "userMessage",
				id: SessionItemId("user-2"),
				text: "second",
			},
		];
		expect(lastUserMessageText(items)).toBe("second");
	});
});
