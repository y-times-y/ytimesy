import { describe, expect, it } from "vitest";
import { claudeCodeListedModels } from "./claude-code-route";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import { chatsWithPinnedFirst } from "./sidebar-chats";
import { turnMayHaveChangedWorkspace } from "./turn-saving";
import {
	relativeTime,
	threadDigest,
	threadHistoryFacts,
	threadsOverview,
	withoutClaudeCodeModels,
	Y_SQUARED_MESSAGE_THREAD_TOOL,
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

	it("tells Y² to answer which-thread questions, name what is not recorded and stay on the project's threads", () => {
		const text = ySquaredInstructions();
		expect(text).toMatch(
			/which thread did X.*created, last active, last request and last reply/,
		);
		expect(text).toContain("name that thread as a link");
		expect(text).toContain("Say plainly what is not recorded");
		expect(text).toContain("who or which agent built Y² itself");
		expect(text).toContain("work done outside this project's threads");
		expect(text).toContain("anything older than the crew's records");
		expect(text).toContain("open the most recently active thread");
		expect(text).toContain(`\`${Y_SQUARED_MESSAGE_THREAD_TOOL}\``);
		expect(text).toContain(
			"Never mention a tool, connection or server failure that is not about them",
		);
	});

	it("formats times relative to now", () => {
		expect(relativeTime(NOW - 20_000, NOW)).toBe("just now");
		expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
		expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
		expect(relativeTime(NOW - 4 * 86_400_000, NOW)).toBe("4 days ago");
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

describe("Y² on a Claude runner", () => {
	it("words the refusal and the outage for the person, never as a bug", async () => {
		const {
			apiTurnFailureMessage,
			ClaudeRunnerRequired,
			YSquaredClaudeRunnerUnreachable,
		} = await import("./api-turn-failure");
		const { failoverReason } = await import("./model-failover-reason");
		const { ClaudeRunnerTransportFailure } = await import("./api-turn-failure");
		expect(new ClaudeRunnerRequired().message).toBe(
			"Y² on a Claude subscription needs the Claude runner, which isn't enabled for your account. Pick a Codex, Grok or API-key model for this chat.",
		);
		const down = new YSquaredClaudeRunnerUnreachable();
		expect(down.message).toBe(
			"The Claude runner is unreachable right now; try again or pick another model for Y².",
		);
		expect(apiTurnFailureMessage("model", down)).toBe(down.message);
		expect(
			apiTurnFailureMessage("model", new ClaudeRunnerRequired()),
		).toContain("needs the Claude runner");
		expect(failoverReason(down)).toBe("outage");
		expect(failoverReason(new ClaudeRunnerRequired())).toBeNull();
		// A bare transport failure keeps its own (non-Y²) wording.
		expect(
			apiTurnFailureMessage(
				"model",
				new ClaudeRunnerTransportFailure("exec", "network"),
			),
		).toContain("outcome is unknown");
	});

	it("gives each chat its own runner directory and refuses a path-like id", async () => {
		const { claudeRunnerSessionWorkdir, CLAUDE_RUNNER_WORKDIR } = await import(
			"./claude-runner"
		);
		const id = "11111111-1111-4111-8111-111111111111";
		expect(claudeRunnerSessionWorkdir(id)).toBe(
			`${CLAUDE_RUNNER_WORKDIR}/${id}`,
		);
		expect(() => claudeRunnerSessionWorkdir("../etc")).toThrow();
	});
});

describe("Y² stays in the loop (instructions)", () => {
	const text = ySquaredInstructions();

	it("acknowledges in one line right away and never goes silent", () => {
		expect(text).toContain("Acknowledge in ONE line right away");
		expect(text).toContain(
			"Started A and B; I'll tell you as each finishes or needs you.",
		);
		expect(text).toContain("Never go silent between a start and the end");
	});

	it("tells a short delta at every wake, and a brief line on a heartbeat", () => {
		expect(text).toContain("At each wake give a short delta");
		expect(text).toContain(
			"A finished, PR #12 opened. B still working, 8 min.",
		);
		expect(text).toContain("never a full re-listing");
		expect(text).toContain("On a still-working wake, one brief line");
		expect(text).toContain("You were not part of this: <thread> got <request>");
	});

	it("answers terse commands tersely, acts, and asks only for real decisions", () => {
		expect(text).toContain('"merge X", "hold Y"');
		expect(text).toContain(`\`${Y_SQUARED_MESSAGE_THREAD_TOOL}\``);
		expect(text).toContain('mode "interrupt"');
		expect(text).toContain("confirm in one line");
		expect(text).toContain(
			"Ask the person only for a real decision or blocker",
		);
	});

	it("points to the live card instead of repeating it, and keeps reports under 100 words", () => {
		expect(text).toContain("The Overview beside this chat lists every thread");
		expect(text).toContain("Prefer steer over interrupt");
		expect(text).toContain("never repeat its content");
		expect(text).toContain("Report in at most 100 words");
		expect(text).toContain("Never poll.");
	});

	it('reports the substance of a finished thread, never just "go read it"', () => {
		expect(text).toContain("never have to open a thread");
		expect(text).toContain("report the SUBSTANCE");
		expect(text).toContain("the decision the person must make");
		expect(text).toContain(
			'Never say only "finished" or "open the thread to read it"',
		);
	});
});
