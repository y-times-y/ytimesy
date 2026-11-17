import { z } from "zod";
import { isClaudeCodeRoute } from "./claude-code-route";
import type { SessionItem } from "./session-item";
import type { ChatWaitingOn } from "./sidebar-chats";
import { ASK_USER_TOOL } from "./user-question";

/**
 * Y² ("Y-squared", Y x Y = ytimesy): one chat per Y project, pinned above
 * its threads. It never works on code and never works inside a thread: it
 * reads every thread (what it waits on from the person, whether it is
 * working, its last reply and pull request) and tells the person what is
 * going on. It holds the project's view across threads, the job DeepSeek's
 * single router does for all of them.
 */

export const Y_SQUARED_TITLE = "Y²";

/**
 * Y² has no machine, and Claude Code (the user's Claude subscription) runs the
 * `claude` CLI on one: a Y² turn is never started on that route. The picker
 * leaves those models out, and the server refuses such a send up front.
 */
export const Y_SQUARED_CLAUDE_CODE_REFUSAL =
	"Y² can't run on a Claude subscription yet. Pick a Codex, Grok or API-key model for this chat.";
/** Shown in the composer when Y²'s remembered model is a Claude Code one. */
export const Y_SQUARED_CLAUDE_CODE_NOTE =
	"Y² runs on Codex, Grok or an API key, not a Claude subscription.";

/** The models Y² may use: everything but the Claude Code routes. */
export function withoutClaudeCodeModels<T extends { readonly id: string }>(
	models: readonly T[],
): T[] {
	return models.filter((model) => !isClaudeCodeRoute(model.id));
}
export const Y_SQUARED_THREADS_TOOL = "threads";
export const Y_SQUARED_THREAD_TOOL = "thread";
export const Y_SQUARED_START_THREAD_TOOL = "start_thread";
export const Y_SQUARED_MESSAGE_THREAD_TOOL = "message_thread";
export const Y_SQUARED_STOP_THREAD_TOOL = "stop_thread";

/**
 * Most `start_thread` calls one Y² turn may make. A bound against a runaway
 * loop, not a thread cap: the per-user turn concurrency (32), the usage
 * windows and the Freestyle and Cloudflare budgets decide what actually runs.
 */
export const Y_SQUARED_MAX_STARTS_PER_TURN = 8;
/** Longest brief or message Y² may send to a thread, in characters. */
export const Y_SQUARED_MESSAGE_LIMIT = 8_000;
export const Y_SQUARED_TITLE_LIMIT = 120;

export const Y_SQUARED_START_THREAD_DESCRIPTION =
	"Start a new thread (a root chat with its own Y and its own machine) in this project. The brief is the thread's first message and must be self-contained: the goal, the constraints and what done looks like, since the thread knows nothing of this chat. Starting may leave the thread queued behind the budget or concurrency limit; the result says which. Start only what is needed.";
export const Y_SQUARED_MESSAGE_THREAD_DESCRIPTION =
	"Send a message to one of this project's threads. A working thread gets it queued behind its turn; an idle thread starts a turn with it (which may itself queue behind the budget or concurrency limit). Pass the id from the threads list.";
export const Y_SQUARED_STOP_THREAD_DESCRIPTION =
	"Stop the running turn of one of this project's threads. Messages already queued in it still go on. Pass the id from the threads list.";

export const startThreadInput = z.object({
	title: z
		.string()
		.trim()
		.min(1)
		.max(Y_SQUARED_TITLE_LIMIT)
		.describe("A short name for the thread"),
	brief: z
		.string()
		.trim()
		.min(1)
		.max(Y_SQUARED_MESSAGE_LIMIT)
		.describe("The thread's first message: self-contained"),
});
export const messageThreadInput = z.object({
	id: z.string().min(1).max(64).describe("The thread's id"),
	text: z.string().trim().min(1).max(Y_SQUARED_MESSAGE_LIMIT),
});
export const stopThreadInput = z.object({
	id: z.string().min(1).max(64).describe("The thread's id"),
});

/** Tools Y² keeps by name: its read tools, its thread tools and the person's questions. */
export const Y_SQUARED_TOOLS: ReadonlySet<string> = new Set([
	Y_SQUARED_THREADS_TOOL,
	Y_SQUARED_THREAD_TOOL,
	Y_SQUARED_START_THREAD_TOOL,
	Y_SQUARED_MESSAGE_THREAD_TOOL,
	Y_SQUARED_STOP_THREAD_TOOL,
	ASK_USER_TOOL,
]);

/** What an empty Y² chat says it is for, and the questions it offers to send. */
export const Y_SQUARED_EMPTY_TEXT = "Y² keeps track of this project's threads.";
export const Y_SQUARED_SUGGESTIONS = [
	"What needs me?",
	"What's running?",
	"Summarize today",
] as const;

/** Threads listed in one overview, most recently active first. */
export const Y_SQUARED_THREAD_LIMIT = 25;
const SNIPPET = 220;

export function ySquaredInstructions() {
	return [
		"You are Y², the ytimesy agent above all of this project's threads. Each thread has its own Y working with the person on one piece of work. You never change, run or read code, and you never do a thread's work: you tell the person what is going on across the threads and, when asked, run threads for them.",
		"",
		`- Call \`${Y_SQUARED_THREADS_TOOL}\` first for the current state of every thread; call \`${Y_SQUARED_THREAD_TOOL}\` for the details of one. Never answer from memory: threads change while you are idle.`,
		'- Keep it short: at most 5 short lines unless the person asks for more. Lead with what needs the person (a question, a secret, a push to approve, a failure), then what is working, then one line for the rest. Never list idle threads one by one: count them ("4 other threads are idle.").',
		`- Name a thread as a link to its id from \`${Y_SQUARED_THREADS_TOOL}\`: [Fix sign-up form](thread:<id>). It shows as a chip the person clicks to open the thread and talk to its Y. Name a pull request by its URL or as pr:owner/repo#123.`,
		"- Write one thread's status as a normal sentence that starts with :needs-you:, :failed:, :finished: or :merged: and then the thread's link; it shows with a small status icon. One sentence each, for example:\n  :needs-you: [Fix sign-up form](thread:<id>) needs you to merge pr:acme/web#8.\n  :failed: [Nightly import](thread:<id>) failed on its last turn: the database was unreachable.",
		`- You may run threads: \`${Y_SQUARED_START_THREAD_TOOL}\` (title, brief), \`${Y_SQUARED_MESSAGE_THREAD_TOOL}\` (id, text), \`${Y_SQUARED_STOP_THREAD_TOOL}\` (id). Only when the person asks for work or for a change to a thread; never on your own idea.`,
		"- Start a thread only with a self-contained brief (goal, constraints, what done looks like): the thread cannot see this chat. Never start more threads than the work needs; one thread per independent piece of work. A started thread may be queued behind the budget or concurrency limit: say how many were started and how many are queued, from the tool results.",
		"- Never poll. After starting or messaging threads, end your turn: you wake by yourself when a thread finishes or needs the person. Do not call `threads` again just to see progress.",
		"- Report in at most 100 words.",
		"- A line starting with ::finished, ::merged, ::failed or ::needs-you is a centered event line for one short event across threads, at most 6 words and no links, for example:\n  ::finished All 3 threads finished\n  Never put a sentence or a thread's details on an event line.",
	].join("\n");
}

/** What a thread waits on from the person, in a few words. */
export function waitingOnText(waiting: ChatWaitingOn) {
	switch (waiting) {
		case "question":
			return "needs your answer to a question";
		case "secret":
			return "needs a secret";
		case "push":
			return "needs you to approve a push";
		case "plan":
			return "needs you to approve a plan";
		case "paused":
			return "is paused on a model switch";
		case "failed":
			return "failed on its last turn";
	}
}

export type ThreadDigest = {
	readonly id: string;
	readonly title: string;
	readonly status: "needs you" | "working" | "idle";
	readonly waitingOn: string | null;
	readonly workingForMinutes: number | null;
	readonly lastRequest: string | null;
	readonly lastReply: string | null;
	readonly pullRequest: string | null;
	readonly updatedAt: string | null;
};

const clip = (text: string, limit = SNIPPET) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** The parts of a thread's history Y² reports: its last request, last reply and pull request. */
export function threadHistoryFacts(items: readonly SessionItem[]) {
	let lastRequest: string | null = null;
	let lastReply: string | null = null;
	let pullRequest: string | null = null;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index] as SessionItem;
		if (!lastReply && item.kind === "agentMessage" && item.text.trim())
			lastReply = clip(item.text);
		if (
			!lastRequest &&
			item.kind === "userMessage" &&
			!("wake" in item && item.wake) &&
			item.text.trim()
		)
			lastRequest = clip(item.text);
		if (
			!pullRequest &&
			item.kind === "notice" &&
			"pullRequest" in item &&
			item.pullRequest?.state === "opened"
		)
			pullRequest = `#${item.pullRequest.number} ${item.pullRequest.url}`;
		if (lastReply && lastRequest && pullRequest) break;
	}
	return { lastRequest, lastReply, pullRequest };
}

/** One thread's digest from its sidebar row and its history. */
export function threadDigest(input: {
	readonly id: string;
	readonly title: string;
	readonly waitingOn: ChatWaitingOn | null;
	readonly workingSince: string | null;
	readonly updatedAt: string | null;
	readonly items: readonly SessionItem[];
	readonly now: number;
}): ThreadDigest {
	const facts = threadHistoryFacts(input.items);
	const since = input.workingSince
		? Date.parse(input.workingSince)
		: Number.NaN;
	return {
		id: input.id,
		title: input.title,
		status: input.waitingOn
			? "needs you"
			: input.workingSince
				? "working"
				: "idle",
		waitingOn: input.waitingOn ? waitingOnText(input.waitingOn) : null,
		workingForMinutes: Number.isFinite(since)
			? Math.max(0, Math.round((input.now - since) / 60_000))
			: null,
		...facts,
		updatedAt: input.updatedAt,
	};
}

const ORDER: Record<ThreadDigest["status"], number> = {
	"needs you": 0,
	working: 1,
	idle: 2,
};

/** The overview Y² reads: threads that need the person first, then working, then idle. */
export function threadsOverview(digests: readonly ThreadDigest[]) {
	if (!digests.length) return "No threads in this project yet.";
	return [...digests]
		.sort(
			(a, b) =>
				ORDER[a.status] - ORDER[b.status] ||
				(b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
		)
		.map((thread) =>
			[
				`- [${thread.status}] "${thread.title}" (id ${thread.id})`,
				thread.waitingOn ? `  waiting: it ${thread.waitingOn}` : "",
				thread.workingForMinutes !== null
					? `  working for ${thread.workingForMinutes} min`
					: "",
				thread.lastRequest ? `  last request: ${thread.lastRequest}` : "",
				thread.lastReply ? `  last reply: ${thread.lastReply}` : "",
				thread.pullRequest ? `  pull request: ${thread.pullRequest}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
}
