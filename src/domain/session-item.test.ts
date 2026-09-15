import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	compactTimelineItems,
	fileChangesFromSessionItems,
	isConversationItem,
	isTurnRunning,
	lastUserMessageText,
	type SessionItem,
	sessionTitleFromItems,
	sessionUsesFollowUpLayout,
	showTurnWorking,
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
					{
						path: "README.md",
						change: "update",
						additions: 4,
						deletions: 1,
						preview: "--- a/README.md\n+setup\n",
					},
					{
						path: "src/app.ts",
						change: "add",
						additions: 12,
						deletions: 0,
						preview: "export {}\n",
					},
				],
			},
		];

		expect(fileChangesFromSessionItems(items)).toEqual([
			{
				path: "README.md",
				change: "update",
				additions: 4,
				deletions: 1,
				preview: "--- a/README.md\n+setup\n",
			},
			{
				path: "src/app.ts",
				change: "add",
				additions: 12,
				deletions: 0,
				preview: "export {}\n",
			},
		]);
	});

	it("keeps the latest preview when the same path is edited again", () => {
		const items: SessionItem[] = [
			{
				kind: "fileChange",
				id: SessionItemId("patch-1"),
				status: "completed",
				changes: [
					{
						path: "todo.py",
						change: "add",
						additions: 10,
						deletions: 0,
						preview: "print(1)\n",
					},
				],
			},
			{
				kind: "fileChange",
				id: SessionItemId("patch-2"),
				status: "completed",
				changes: [
					{
						path: "todo.py",
						change: "update",
						additions: 2,
						deletions: 1,
						preview: "print(2)\n",
					},
				],
			},
		];

		expect(fileChangesFromSessionItems(items)).toEqual([
			{
				path: "todo.py",
				change: "update",
				additions: 2,
				deletions: 1,
				preview: "print(2)\n",
			},
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
		expect(
			lastUserMessageText([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "What is this repository?",
				},
				{
					kind: "userMessage",
					id: SessionItemId("preamble"),
					text: "You are in a ytimesy workspace VM. The project checkout is /home/ubuntu; work there.\n\nWhat is this repository?",
				},
			]),
		).toBe("What is this repository?");
	});

	it("uses the first line of the latest user message as the session title", () => {
		expect(sessionTitleFromItems([])).toBe("New session");
		expect(
			sessionTitleFromItems([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "fix the composer\nmore detail",
				},
			]),
		).toBe("fix the composer");
	});

	it("keeps reasoning interleaved with tools the way Cursor Cloud does", () => {
		expect(
			compactTimelineItems([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "create hero",
				},
				{
					kind: "reasoning",
					id: SessionItemId("r1"),
					summaries: ["first"],
					durationSeconds: 4,
				},
				{
					kind: "agentMessage",
					id: SessionItemId("m0"),
					text: "I’ll create the file.",
				},
				{
					kind: "commandExecution",
					id: SessionItemId("cmd-1"),
					command: `mkdir -p /tmp/src && cat > /tmp/src/hero.tsx <<'EOF'\nexport const hero = { title: "ytimesy" };\nEOF`,
					cwd: "/tmp",
					status: "completed",
					output: null,
					exitCode: 0,
				},
				{
					kind: "reasoning",
					id: SessionItemId("r2"),
					summaries: ["second"],
					durationSeconds: 1,
				},
				{
					kind: "agentMessage",
					id: SessionItemId("m1"),
					text: "ok",
				},
			]).map((item) => item.kind),
		).toEqual([
			"userMessage",
			"reasoning",
			"agentMessage",
			"fileChange",
			"reasoning",
			"agentMessage",
		]);
	});

	it("hides the internal workspace preamble from the transcript", () => {
		expect(
			compactTimelineItems([
				{
					kind: "userMessage",
					id: SessionItemId("user-1"),
					text: "What is this repository?",
				},
				{
					kind: "userMessage",
					id: SessionItemId("user-preamble"),
					text: "You are in a ytimesy workspace VM. The project checkout is /home/ubuntu/ytimesy; work there.\n\nWhat is this repository?",
				},
			]).map((item) => item.id),
		).toEqual([SessionItemId("user-1")]);
	});

	it("does not add a second Thinking row while a thought is already open", () => {
		expect(
			showTurnWorking(
				[
					{
						kind: "userMessage",
						id: SessionItemId("user-1"),
						text: "look",
					},
					{
						kind: "reasoning",
						id: SessionItemId("r1"),
						summaries: ["checking the repo"],
					},
				],
				"running",
			),
		).toBe(false);
		expect(
			showTurnWorking(
				[
					{
						kind: "userMessage",
						id: SessionItemId("user-1"),
						text: "look",
					},
				],
				"running",
			),
		).toBe(true);
	});

	it("collects Diff files from shell heredoc writes", () => {
		expect(
			fileChangesFromSessionItems([
				{
					kind: "commandExecution",
					id: SessionItemId("cmd-1"),
					command: `cat > src/hero.tsx <<'EOF'\nexport const hero = { title: "ytimesy" };\nEOF`,
					cwd: "/tmp",
					status: "completed",
					output: null,
					exitCode: 0,
				},
			]),
		).toEqual([
			{
				path: "src/hero.tsx",
				change: "add",
				additions: 1,
				deletions: 0,
				preview: 'export const hero = { title: "ytimesy" };',
			},
		]);
	});

	it("keeps the tall composer until the user actually starts a turn", () => {
		expect(sessionUsesFollowUpLayout({ items: [], turnStatus: "idle" })).toBe(
			false,
		);
		expect(
			sessionUsesFollowUpLayout({
				items: [
					{
						kind: "userMessage",
						id: SessionItemId("user-1"),
						text: "fix the composer",
					},
				],
				turnStatus: "idle",
			}),
		).toBe(true);
		expect(
			sessionUsesFollowUpLayout({ items: [], turnStatus: "running" }),
		).toBe(true);
	});
});
