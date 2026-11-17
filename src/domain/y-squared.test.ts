import { describe, expect, it } from "vitest";
import { claudeCodeListedModels } from "./claude-code-route";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import { chatsWithPinnedFirst } from "./sidebar-chats";
import { turnMayHaveChangedWorkspace } from "./turn-saving";
import {
	threadDigest,
	threadHistoryFacts,
	threadsOverview,
	withoutClaudeCodeModels,
	Y_SQUARED_THREADS_TOOL,
	Y_SQUARED_TOOLS,
	ySquaredInstructions,
} from "./y-squared";

const id = (value: string) => SessionItemId(value);
const NOW = Date.parse("2026-11-12T12:00:00Z");

const history: SessionItem[] = [
	{
		kind: "userMessage",
		id: id("t1:u"),
		text: "Add a --verbose flag",
	} as SessionItem,
	{
		kind: "agentMessage",
		id: id("t1:a"),
		text: "Started builder 1.",
	} as SessionItem,
	{
		kind: "userMessage",
		id: id("t2:wake"),
		text: "(report)",
		wake: true,
	} as SessionItem,
	{
		kind: "agentMessage",
		id: id("t2:a"),
		text: "The --verbose flag is in; tests pass.",
	} as SessionItem,
	{
		kind: "notice",
		id: id("t2:publication"),
		message: "",
		pullRequest: {
			state: "opened",
			number: 12,
			url: "https://github.com/o/r/pull/12",
			draft: true,
			created: true,
		},
	} as SessionItem,
];

describe("threadHistoryFacts", () => {
	it("takes the person's last request (not a wake-up), the last reply and the pull request", () => {
		expect(threadHistoryFacts(history)).toEqual({
			lastRequest: "Add a --verbose flag",
			lastReply: "The --verbose flag is in; tests pass.",
			pullRequest: "#12 https://github.com/o/r/pull/12",
		});
	});
});

describe("threadsOverview", () => {
	const digest = (input: Partial<Parameters<typeof threadDigest>[0]>) =>
		threadDigest({
			id: "x",
			title: "x",
			waitingOn: null,
			workingSince: null,
			updatedAt: "2026-11-12T11:00:00Z",
			items: [],
			now: NOW,
			...input,
		});

	it("puts what needs the person first, then what is working, then idle", () => {
		const text = threadsOverview([
			digest({ id: "idle", title: "Idle one", items: history }),
			digest({
				id: "work",
				title: "Working one",
				workingSince: "2026-11-12T11:50:00Z",
			}),
			digest({ id: "ask", title: "Asking one", waitingOn: "question" }),
		]);
		const order = ["Asking one", "Working one", "Idle one"].map((title) =>
			text.indexOf(title),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(text).toContain("waiting: it needs your answer to a question");
		expect(text).toContain("working for 10 min");
		expect(text).toContain("pull request: #12");
		// The ids Y² links threads by (thread:<id>).
		expect(text).toContain('"Asking one" (id ask)');
	});

	it("says so when there are no threads", () => {
		expect(threadsOverview([])).toBe("No threads in this project yet.");
	});
});

describe("Y² surface", () => {
	it("keeps only its read tools and the person's questions", () => {
		expect([...Y_SQUARED_TOOLS].sort()).toEqual([
			"ask_user",
			"message_thread",
			"start_thread",
			"stop_thread",
			"thread",
			"threads",
		]);
	});

	it("tells Y² to read the threads before answering and never to work", () => {
		const text = ySquaredInstructions();
		expect(text).toContain("You never change, run or read code");
		expect(text).toContain(`Call \`${Y_SQUARED_THREADS_TOOL}\` first`);
	});

	it("tells Y² to link threads by id and to put events on lines of their own", () => {
		const text = ySquaredInstructions();
		expect(text).toContain("[Fix sign-up form](thread:<id>)");
		expect(text).toContain("pr:owner/repo#123");
		expect(text).toMatch(/^ {2}::finished All 3 threads finished$/m);
		expect(text).toContain("at most 6 words and no links");
		expect(text).toMatch(
			/^ {2}:needs-you: \[Fix sign-up form\]\(thread:<id>\) needs you to merge pr:acme\/web#8\.$/m,
		);
		// No example event line carries a thread or reads as a sentence.
		for (const line of text.match(/^ {2}::\S+ .*$/gm) ?? []) {
			expect(line).not.toContain("thread:");
			expect(line.trim().split(/\s+/).length).toBeLessThanOrEqual(7);
		}
	});

	it("keeps Y²'s replies to a few lines, needs first, idle threads counted", () => {
		const text = ySquaredInstructions();
		expect(text).toContain("at most 5 short lines");
		expect(text).toContain("Lead with what needs the person");
		expect(text).toContain("Never list idle threads one by one");
	});

	it("does not count Y²'s reads as a change that needs a commit", () => {
		const items: SessionItem[] = [
			{
				kind: "dynamicToolCall",
				id: id("turn:1"),
				tool: "threads",
				status: "completed",
			} as SessionItem,
		];
		expect(turnMayHaveChangedWorkspace(items, "turn")).toBe(false);
	});
});

describe("chatsWithPinnedFirst with Y²", () => {
	it("lists Y² first, before the person's pins", () => {
		const chats = [
			{ id: "a", title: "A" },
			{ id: "y2", title: "Y²", role: "y2" as const },
			{ id: "b", title: "B" },
		];
		expect(chatsWithPinnedFirst(chats, ["b"]).map((chat) => chat.id)).toEqual([
			"y2",
			"b",
			"a",
		]);
	});
});

describe("Y² write tools", () => {
	it("tells Y² to brief fully, count started vs queued, never poll and be brief", () => {
		const text = ySquaredInstructions();
		expect(text).toContain("self-contained brief");
		expect(text).toContain("how many were started and how many are queued");
		expect(text).toContain("Never poll");
		expect(text).toContain("at most 100 words");
	});

	it("keeps the write tools out of the workspace-changing set (Y² has no checkout)", () => {
		for (const tool of ["start_thread", "message_thread", "stop_thread"]) {
			expect(
				turnMayHaveChangedWorkspace(
					[
						{
							kind: "dynamicToolCall",
							id: "t1:c",
							tool,
						} as never,
					],
					"t1",
				),
			).toBe(false);
		}
	});
});

describe("Y² model picker", () => {
	it("leaves the Claude Code models out and keeps Codex, Grok and API-key ones", () => {
		const grok = "api/0f8fad5b-d9cb-469f-a165-70867728950e/x-ai/grok-4";
		const key = "api/0f8fad5b-d9cb-469f-a165-70867728950e/openai/gpt-6";
		const models = [
			...claudeCodeListedModels(),
			{ id: "gpt-5.3-codex-spark", label: "Codex" },
			{ id: grok, label: "Grok plan" },
			{ id: key, label: "API key" },
		];
		expect(withoutClaudeCodeModels(models).map((model) => model.id)).toEqual([
			"gpt-5.3-codex-spark",
			grok,
			key,
		]);
		expect(withoutClaudeCodeModels(claudeCodeListedModels())).toEqual([]);
	});
});
