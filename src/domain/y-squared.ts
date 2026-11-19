import { z } from "zod";
import { SHOW_CANVAS_TOOL } from "./canvas";
import { isClaudeCodeRoute } from "./claude-code-route";
import type { SessionItem } from "./session-item";
import type { ChatWaitingOn } from "./sidebar-chats";
import { ASK_USER_TOOL } from "./user-question";
import {
	Y_SQUARED_QUIET_REPLY,
	Y_SQUARED_SCHEDULE_LIMIT,
	Y_SQUARED_SCHEDULE_TOOL,
} from "./y-squared-proactive";

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
 * What the person sees as this chat's name (sidebar section, chat header,
 * Overview tab, empty state). The stored title above stays "Y²" and is never
 * shown for it.
 */
export const SUPER_AGENT_NAME = "Super agent";

/**
 * Y² has no machine, and Claude Code (the user's Claude subscription) runs the
 * `claude` CLI on one, unless the user has a Claude runner box
 * (claude-runner.ts): there the CLI runs with no machine at all and only
 * ytimesy's tools. Without a runner a Y² turn is never started on that route:
 * the picker leaves those models out and the server refuses the send up front.
 */
export const Y_SQUARED_CLAUDE_RUNNER_REFUSAL =
	"Y² on a Claude subscription needs the Claude runner, which isn't enabled for your account. Pick a Codex, Grok or API-key model for this chat.";
export const Y_SQUARED_CLAUDE_CODE_REFUSAL = Y_SQUARED_CLAUDE_RUNNER_REFUSAL;
/** A Y² turn on Claude whose runner box cannot be reached. */
export const Y_SQUARED_CLAUDE_RUNNER_UNREACHABLE =
	"The Claude runner is unreachable right now; try again or pick another model for Y².";
/** Shown in the composer when Y²'s remembered model is a Claude Code one. */
export const Y_SQUARED_CLAUDE_CODE_NOTE =
	"Y² on a Claude subscription needs the Claude runner, which isn't enabled for your account.";

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
export const Y_SQUARED_READ_CANVAS_TOOL = "read_canvas";
export const Y_SQUARED_SHOW_CANVAS_TOOL = SHOW_CANVAS_TOOL;

/**
 * Most `start_thread` calls one Y² turn may make. A bound against a runaway
 * loop, not a thread cap: the per-user turn concurrency (32), the usage
 * windows and the Freestyle and Cloudflare budgets decide what actually runs.
 */
export const Y_SQUARED_MAX_STARTS_PER_TURN = 8;
/** Longest brief or message Y² may send to a thread, in characters. */
export const Y_SQUARED_MESSAGE_LIMIT = 8_000;
export const Y_SQUARED_TITLE_LIMIT = 120;

export const Y_SQUARED_THREAD_DESCRIPTION =
	"One thread's details and what it produced: its status, times, last request, pull request, and its FULL final reply (a very long one shows its start and end), any questions it asked the person, a plan it proposed, and the canvases it showed. Read this when a thread finished or needs the person, then tell the person the substance. Pass the id from the threads list.";
export const Y_SQUARED_READ_CANVAS_DESCRIPTION =
	"Read what one canvas of a thread says, as text: its headings, paragraphs, lists and tables, with [image: alt] and [svg: title] where pictures are, for the latest revision (the result names the revision and the document's size). At most 12,000 characters per call; a longer canvas has more parts: pass part 2, 3, … for the rest. Never returns the HTML or image data. Pass the thread's id and the canvas's title from the thread tool.";
export const Y_SQUARED_SHOW_CANVAS_DESCRIPTION =
	"Show the latest revision of one canvas of a thread in THIS chat, so the person sees it, steps between revisions and pins notes on it here instead of opening the thread. Pass the thread's id and the canvas's title from the thread tool. You read only a short confirmation, never the document. Call it again after the thread publishes a new revision of the same title.";
export const readCanvasInput = z.object({
	id: z.string().min(1).max(64).describe("The thread's id"),
	title: z.string().min(1).max(120).describe("The canvas's title"),
	part: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Which part of a long canvas (from 1); default 1"),
});
export const showCanvasInput = z.object({
	id: z.string().min(1).max(64).describe("The thread's id"),
	title: z.string().min(1).max(120).describe("The canvas's title"),
});
export const Y_SQUARED_START_THREAD_DESCRIPTION =
	"Start a new thread (a root chat with its own Y and its own machine) in this project. The brief is the thread's first message and must be self-contained: the goal, the constraints and what done looks like, since the thread knows nothing of this chat. Starting may leave the thread queued behind the budget or concurrency limit; the result says which. Start only what is needed.";
export const Y_SQUARED_MESSAGE_THREAD_DESCRIPTION =
	'Send a message to one of this project\'s threads. Pass the id from the threads list. An idle thread starts a turn with it (which may itself queue behind the budget or concurrency limit), whatever the mode. For a working thread, mode decides: "queue" (default) puts it behind the running turn, which starts its next turn with it when it ends (several may wait, in order, at most 50); "steer" delivers it at the thread\'s next step, with no extra turn, for a correction while it works (a Claude Code thread takes it only after its next tool call; a thread on a runner box may see it up to 10 s late; a turn that ends first starts its next turn with it); "interrupt" stops the running turn first, then sends it. Steer for a correction while it works, queue when it can wait for the turn to end, interrupt only to stop wrong work.';
/** How message_thread reaches a working thread. */
export const Y_SQUARED_MESSAGE_MODES = ["queue", "interrupt", "steer"] as const;
export type YSquaredMessageMode = (typeof Y_SQUARED_MESSAGE_MODES)[number];
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
	mode: z
		.enum(Y_SQUARED_MESSAGE_MODES)
		// Optional, not .default(): the schema every route shows the model keeps
		// the parameter plainly optional; execute applies "queue".
		.optional()
		.describe(
			"queue (default): after the running turn, as its next turn. steer: at its next step, no extra turn. interrupt: stop the running turn, then send.",
		),
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
	Y_SQUARED_READ_CANVAS_TOOL,
	Y_SQUARED_SHOW_CANVAS_TOOL,
	Y_SQUARED_SCHEDULE_TOOL,
	ASK_USER_TOOL,
]);

/** What an empty Y² chat says it is for, and the questions it offers to send. */
export const Y_SQUARED_EMPTY_TEXT = `${SUPER_AGENT_NAME} keeps track of this project's threads.`;
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
		`- You may run threads: \`${Y_SQUARED_START_THREAD_TOOL}\` (title, brief), \`${Y_SQUARED_MESSAGE_THREAD_TOOL}\` (id, text, mode), \`${Y_SQUARED_STOP_THREAD_TOOL}\` (id). Only when the person asks for work or for a change to a thread; never on your own idea.`,
		"- Start a thread only with a self-contained brief (goal, constraints, what done looks like): the thread cannot see this chat. Never start more threads than the work needs; one thread per independent piece of work. A started thread may be queued behind the budget or concurrency limit: say how many were started and how many are queued, from the tool results.",
		'- Acknowledge in ONE line right away when the person asks for something or you start, message or stop threads, naming what you did: "Started A and B; I\'ll tell you as each finishes or needs you." Never go silent between a start and the end.',
		'- You wake when a thread finishes a turn, needs the person or fails, when the person starts a thread themselves, and about every 10 minutes while threads are still working. At each wake give a short delta ("A finished, PR #12 opened. B still working, 8 min."), never a full re-listing. A still-working wake with nothing new and no follow-up signal needs no message at all (see Quiet wakes). "You were not part of this: <thread> got <request>" means the person messaged that thread directly: take it into account, do not repeat it back.',
		"- Never poll. After starting or messaging threads, end your turn: you wake by yourself. Do not call `threads` again just to see progress.",
		`- Choosing how a message reaches a working thread (\`${Y_SQUARED_MESSAGE_THREAD_TOOL}\` mode): "queue" (default) when it can wait for the turn to end, a follow-up or a next step; "steer" for a correction or new fact the thread should use now, without losing its work (it reads it at its next step); "interrupt" only when its current work is wrong or must stop at once: the running turn is cancelled (what it already did stays in the thread), then your message starts its next turn. An idle thread just starts. Prefer steer over interrupt, and interrupt over a separate stop. Say which mode you used.`,
		`- Answer terse commands tersely and act: "merge X", "hold Y" -> \`${Y_SQUARED_MESSAGE_THREAD_TOOL}\` (mode "interrupt" to stop the running turn first, else the default) or \`${Y_SQUARED_STOP_THREAD_TOOL}\`, then confirm in one line. Ask the person only for a real decision or blocker.`,
		"- The Overview beside this chat lists every thread (needs you, in progress, pull requests) without you: point to it, never repeat its content.",
		`- The person should never have to open a thread to learn what it did. When a thread finished or needs the person, call \`${Y_SQUARED_THREAD_TOOL}\` for it (the wake only names it) and report the SUBSTANCE: the outcome in a sentence or two (what it found or built, the key numbers, the pull request link, any canvas it showed), then the decision the person must make, if there is one, as a question they can answer in a word. Never say only "finished" or "open the thread to read it": you can read its full final reply. A very long reply shows its start and end: summarise its most important findings first and offer to go deeper on a part; if you need a detail you cannot see, ask the thread with \`${Y_SQUARED_MESSAGE_THREAD_TOOL}\` and report when it answers. Link the thread only as a pointer for the full text.`,
		`- Canvases: \`${Y_SQUARED_THREAD_TOOL}\` lists each canvas a thread showed (title, latest revision, size, a short description). To know what one says, call \`${Y_SQUARED_READ_CANVAS_TOOL}\` (id, title; pass part for a long one): you get its text, never its HTML. To let the person see it, call \`${Y_SQUARED_SHOW_CANVAS_TOOL}\` (id, title): it appears in THIS chat with the thread's revision number, and the person previews, compares and pins notes on it here. Do it when the person asks to see it or when a thread's canvas is the thing to look at; never paste or describe the HTML.`,
		`- Feedback on a canvas: a message starting 'Canvas feedback on "<title>" (revision N) [thread:<id>]' is the person's notes on a canvas that thread <id> owns. Do not apply it yourself and do not summarise it away: send it to THAT thread with \`${Y_SQUARED_MESSAGE_THREAD_TOOL}\` (mode "steer" if the thread is working, else the default, which starts an idle thread), forwarding the person's notes verbatim with their element selectors, the title and the revision, and asking the thread to publish the next revision with the SAME canvas title. Say in one line that you sent it, then end your turn: you wake when the thread settles. On that wake, if the thread showed a new revision of a canvas you displayed, call \`${Y_SQUARED_SHOW_CANVAS_TOOL}\` again with the same title so the new revision appears here, and tell the person what changed in one or two lines. A feedback message without a [thread:<id>] marker names no owner: ask which thread it belongs to only if the \`${Y_SQUARED_THREADS_TOOL}\` titles do not make it clear.`,
		"- Report in at most 100 words (about 100 for each thread you report on), substance first.",
		`- For "which thread did X", "which was last used" or "which thread created Y": answer from each thread's created, last active, last request and last reply in \`${Y_SQUARED_THREADS_TOOL}\`, and name that thread as a link. If none fits, say so and name the closest.`,
		`- Say plainly what is not recorded, never only "I can't see": who or which agent built Y² itself, work done outside this project's threads, and anything older than the crew's records (a thread shows "created not recorded" when it predates them). Then give a next step: open the most recently active thread, or ask it with \`${Y_SQUARED_MESSAGE_THREAD_TOOL}\`.`,
		"- Report only on this project's threads. Never mention a tool, connection or server failure that is not about them.",
		"- A line starting with ::finished, ::merged, ::failed or ::needs-you is a centered event line for one short event across threads, at most 6 words and no links, for example:\n  ::finished All 3 threads finished\n  Never put a sentence or a thread's details on an event line.",
		"",
		"Acting on your own (you are proactive: the person should mostly talk to you alone, so do not hand them routine work):",
		`- Handle routine things yourself, then tell the person in one line what you did: re-send a thread that failed for a transient reason (\`${Y_SQUARED_MESSAGE_THREAD_TOOL}\`, say what to retry), steer a thread that looks stuck or off track (mode "steer"), start a follow-up thread the person already approved or asked for. A thread that failed for the same reason twice is a blocker, not a retry.`,
		'- Escalate only a real blocker (a missing secret, a decision only the person can make, a failure you cannot fix) or an irreversible or costly decision: merge, deploy, delete, spend money, force-push. Ask ONE line with the choice and your recommendation ("Merge pr:acme/web#8? It is green; I recommend yes."), via `ask_user` when the answer is a choice. Never merge, deploy, delete or spend on your own.',
		"- Follow-up signals in a wake (a thread working far longer than usual, waiting on the person for a long time) are sent once: act on them (steer the stuck thread with a concrete question or correction, or stop it if it is wrong; for a waiting thread you may answer it yourself only if the answer is routine and already known from the person's earlier words) and say so in one line. A thread's pull request failing CI or sitting unmerged is not tracked by you: only report it if a thread's own reply says so.",
		"- Never repeat a reminder or a question you already asked; if the person has not answered, say nothing new until something changes.",
		`- Scheduled check-ins: only when the person asks ("every weekday 9am give me a digest", "in 2 hours check on the audit thread"), with \`${Y_SQUARED_SCHEDULE_TOOL}\` (create, list, cancel; at most ${Y_SQUARED_SCHEDULE_LIMIT} active). Say the time zone you used. When a scheduled check-in wakes you, do what its saved prompt says, then report in a few lines.`,
		`- Quiet wakes: end every proactive wake with either a concrete ask or a one-line result of what you did, or, when nothing changed that the person needs to know and nothing needs action, with exactly ${Y_SQUARED_QUIET_REPLY} and nothing else (it shows no message; do not call tools first when the wake text already shows nothing needs you). Never post "all quiet", "still working" or "nothing new" as a message.`,
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
	/** When the crew first noted the thread (ISO); null when not recorded. */
	readonly createdAt: string | null;
	/** When the person or a wake last used the thread (ISO); null when not recorded. */
	readonly lastActiveAt: string | null;
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
		createdAt: null,
		lastActiveAt: null,
	};
}

const ORDER: Record<ThreadDigest["status"], number> = {
	"needs you": 0,
	working: 1,
	idle: 2,
};

/** "3 h ago": how long before `now` something happened. */
export function relativeTime(at: number, now: number) {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

/** One short line: when the thread was last used and created, or that it is not recorded. */
export function threadTimesText(thread: ThreadDigest, now: number) {
	const active = Date.parse(thread.lastActiveAt ?? thread.updatedAt ?? "");
	const created = Date.parse(thread.createdAt ?? "");
	return [
		Number.isFinite(active)
			? `last active ${relativeTime(active, now)}`
			: "last active not recorded",
		Number.isFinite(created)
			? `created ${new Date(created).toISOString().slice(0, 10)}`
			: "created not recorded",
	].join(" · ");
}

/** The overview Y² reads: threads that need the person first, then working, then idle (most recently active first). */
export function threadsOverview(
	digests: readonly ThreadDigest[],
	now: number = Date.now(),
) {
	if (!digests.length) return "No threads in this project yet.";
	return [...digests]
		.sort(
			(a, b) =>
				ORDER[a.status] - ORDER[b.status] ||
				(b.lastActiveAt ?? b.updatedAt ?? "").localeCompare(
					a.lastActiveAt ?? a.updatedAt ?? "",
				),
		)
		.map((thread) =>
			[
				`- [${thread.status}] "${thread.title}" (id ${thread.id})`,
				thread.waitingOn
					? `  waiting: it ${thread.waitingOn}`
					: thread.workingForMinutes !== null
						? `  working for ${thread.workingForMinutes} min`
						: "",
				`  ${threadTimesText(thread, now)}`,
				thread.lastRequest ? `  last request: ${thread.lastRequest}` : "",
				thread.lastReply ? `  last reply: ${thread.lastReply}` : "",
				thread.pullRequest ? `  pull request: ${thread.pullRequest}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
}
