import { describe, expect, it } from "vitest";
import { claudeCodeListedModels } from "./claude-code-route";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import { chatsWithPinnedFirst } from "./sidebar-chats";
import { turnMayHaveChangedWorkspace } from "./turn-saving";
import {
	openChatIsSuperAgent,
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
import { crewWakeBody } from "./y-squared-crew";

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
			"read_canvas",
			"schedule",
			"show_canvas",
			"start_thread",
			"stop_thread",
			"thread",
			"threads",
			"view_image",
		]);
	});

	it("routes canvas feedback to the owning thread and re-shows the new revision", () => {
		const text = ySquaredInstructions();
		expect(text).toContain("[thread:<id>]");
		expect(text).toContain("send it to THAT thread");
		expect(text).toContain('mode "steer" if the thread is working');
		expect(text).toContain("verbatim with their element selectors");
		expect(text).toContain("SAME canvas title");
		expect(text).toContain("call `show_canvas` again with the same title");
		expect(text).toContain("`read_canvas`");
		expect(text).toContain("a bounded window of the source");
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
		expect(text).toContain("at most 60 words in all");
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

describe("Y² reports briefly and quietly (instructions)", () => {
	const text = ySquaredInstructions();

	it("uses one length rule: 60 words in all, never the old per-thread 100", () => {
		expect(text).toContain(
			"at most 60 words in all, however many threads changed",
		);
		expect(text).not.toContain("about 100 for each thread");
		expect(text).not.toContain("100 words");
	});

	it("forbids tables and long bullet lists unless asked", () => {
		expect(text).toContain("no tables, no headings and at most 3 bullets");
		expect(text).toContain(
			"unless the person asks for a table or a full report",
		);
	});

	it("puts one decision per message and counts the rest", () => {
		expect(text).toContain("at most ONE decision to the person per message");
		expect(text).toContain("with your recommendation");
		expect(text).toContain("2 more need you");
	});

	it("never repeats reported threads, asked decisions or old open items", () => {
		expect(text).toContain("Never repeat yourself");
		expect(text).toContain("restate a decision you already put to the person");
		expect(text).toContain(
			"unless something about it changed since your last message",
		);
		expect(text).toContain("Resolved items are never mentioned again");
		expect(text).toContain(
			"status card above this chat already shows what is open",
		);
	});

	it("groups finished threads on one line and keeps digests to 10 lines on request", () => {
		expect(text).toContain("3 threads finished: A, B, C");
		expect(text).toContain(
			"at most 10 lines in three groups, Needs you, Done, Working",
		);
		expect(text).toContain("say nothing");
	});

	it("the wake text asks for the same short, non-repeating delta", () => {
		const wake = crewWakeBody({
			events: [],
			working: [],
			now: 0,
			proactive: ["x"],
		});
		expect(wake).toContain("at most 60 words");
		expect(wake).toContain("Skip anything you already reported");
		expect(wake).toContain("use no tables");
		expect(wake).not.toContain("Never just say it finished");
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

	it("tells a short delta at every wake, and nothing on a quiet heartbeat", () => {
		expect(text).toContain("At each wake give a short delta");
		expect(text).toContain(
			"A finished, PR #12 opened. B still working, 8 min.",
		);
		expect(text).toContain("never a full re-listing");
		expect(text).toContain("needs no message at all");
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
		expect(text).toContain("Report in at most 60 words in all");
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

describe("Y² acts on its own (instructions)", () => {
	const text = ySquaredInstructions();

	it("handles routine things itself and escalates only blockers and costly decisions", () => {
		expect(text).toContain("Handle routine things yourself");
		expect(text).toContain("re-send a thread that failed");
		expect(text).toContain("steer a thread that looks stuck");
		expect(text).toContain(
			"start a follow-up thread the person already approved",
		);
		expect(text).toContain("Escalate only a real blocker");
		expect(text).toContain("merge, deploy, delete, spend money");
		expect(text).toContain("Ask ONE line");
		expect(text).toContain("Never merge, deploy, delete or spend on your own");
	});

	it("never repeats a reminder and says what it does not track", () => {
		expect(text).toContain("Never repeat a reminder");
		expect(text).toContain("sent once");
		expect(text).toContain("failing CI or sitting unmerged is not tracked");
	});

	it("schedules only on request, and ends proactive wakes quietly or with an ask", () => {
		expect(text).toContain("Scheduled check-ins: only when the person asks");
		expect(text).toContain("`schedule`");
		expect(text).toContain("at most 10 active");
		expect(text).toContain("Say the time zone you used");
		expect(text).toContain("exactly NOTHING_TO_REPORT and nothing else");
		expect(text).toContain("a concrete ask");
		expect(text).toContain('Never post "all quiet"');
	});
});

describe("openChatIsSuperAgent", () => {
	const project = { ySquaredId: "super-1" };
	it("follows the chat list when it has the open chat", () => {
		expect(
			openChatIsSuperAgent({
				activeChat: { role: "y2" },
				activeSessionId: "super-1",
				project,
			}),
		).toBe(true);
		expect(
			openChatIsSuperAgent({
				activeChat: {},
				activeSessionId: "thread-1",
				project,
			}),
		).toBe(false);
	});
	it("knows the Super agent from the project while the list has not arrived", () => {
		expect(openChatIsSuperAgent({ activeSessionId: "super-1", project })).toBe(
			true,
		);
	});
	it("never takes another chat, or a project without one, for the Super agent", () => {
		expect(openChatIsSuperAgent({ activeSessionId: "thread-1", project })).toBe(
			false,
		);
		expect(
			openChatIsSuperAgent({
				activeSessionId: "super-1",
				project: { ySquaredId: null },
			}),
		).toBe(false);
		expect(openChatIsSuperAgent({ activeSessionId: undefined, project })).toBe(
			false,
		);
	});
});
