/**
 * Y²'s judgement of finished ("settled") threads, decided from facts the
 * server gathers (src/server/services/y-squared-settled.ts), never from the
 * model's memory. The model may keep a thread the rules would archive (a
 * follow-up is likely, its context is worth keeping); it can never archive
 * one the hard rules keep (unpushed work, a pending question, an open pull
 * request, a recent conversation).
 *
 * Every settled thread holds a paused VM (about $3 a month at 32 GiB) until
 * the retention sweep, so finished work that has landed should leave the list.
 */

/** Idle time (since the thread settled or the person last wrote to it) before landed work is archived. */
export const SETTLED_ARCHIVE_IDLE_HOURS_DEFAULT = 24;
/** A failed, duplicate or obsolete thread waits this long (room for the one retry). */
export const SETTLED_DISCARD_IDLE_HOURS = 6;
/** Threads listed per call: the rest are counted. */
export const SETTLED_LIST_LIMIT = 40;
/** Archives per batch call. */
export const SETTLED_ARCHIVE_BATCH_LIMIT = 20;
/** Reuse candidates returned: enough to choose, few enough to stay cheap. */
export const REUSE_CANDIDATE_LIMIT = 3;
/** A thread with more transcript items than this carries too much stale context to reuse. */
export const REUSE_MAX_ITEMS = 600;
/** A thread idle longer than this is no longer "recent" for reuse. */
export const REUSE_MAX_IDLE_HOURS = 72;
export const HOUR_MS = 60 * 60 * 1000;

export type SettledPullRequest =
	| "none"
	| "open"
	| "merged"
	| "closed"
	| "unknown";

/**
 * Where the thread's work stands:
 * - `none`: it produced no changes;
 * - `landed`: its changes are on the default branch or in a merged pull request;
 * - `pushed`: committed and pushed to its branch, not merged;
 * - `unpushed`: committed (or edited) here, the push did not happen;
 * - `unknown`: the server could not tell.
 */
export type SettledWork = "none" | "landed" | "pushed" | "unpushed" | "unknown";

export type SettledFacts = {
	readonly state: "working" | "waiting" | "failed" | "finished";
	/** Milliseconds since the thread's last change (its turn settled). */
	readonly settledAgeMs: number;
	/** Milliseconds since the person last wrote to the thread; null: never. */
	readonly lastUserMessageAgeMs: number | null;
	readonly pullRequest: SettledPullRequest;
	readonly work: SettledWork;
	/** An unanswered question, a plan or push approval, a secret request. */
	readonly pendingQuestion: boolean;
	/** The model's judgement that the thread is a duplicate or obsolete (never overrides a hard rule). */
	readonly discard?: "duplicate" | "obsolete";
};

export type SettledPolicy = { readonly idleHours: number };

export const settledPolicy = (idleHours?: number | null): SettledPolicy => ({
	idleHours:
		idleHours && Number.isFinite(idleHours) && idleHours > 0
			? idleHours
			: SETTLED_ARCHIVE_IDLE_HOURS_DEFAULT,
});

export type SettledReasonCode =
	| "working"
	| "needs-person"
	| "unpushed-work"
	| "work-unknown"
	| "open-pull-request"
	| "pull-request-unknown"
	| "recent-conversation"
	| "idle-not-long-enough"
	| "pushed-awaiting-merge"
	| "landed"
	| "no-changes"
	| "failed"
	| "duplicate"
	| "obsolete";

export type SettledDecision = {
	readonly action: "archive" | "keep";
	readonly code: SettledReasonCode;
	/** A short sentence, shown to Y² and kept in the decision log. */
	readonly reason: string;
	/** A hard keep that the model may not override. */
	readonly hard: boolean;
};

const keep = (
	code: SettledReasonCode,
	reason: string,
	hard: boolean,
): SettledDecision => ({ action: "keep", code, reason, hard });
const archive = (code: SettledReasonCode, reason: string): SettledDecision => ({
	action: "archive",
	code,
	reason,
	hard: false,
});

const hoursText = (ms: number) => `${Math.max(0, Math.floor(ms / HOUR_MS))} h`;

/**
 * Keep or archive one settled thread. The order is the safety order: nothing
 * pending or unpushed is ever archived, whatever the age.
 */
export function decideSettledThread(
	facts: SettledFacts,
	policy: SettledPolicy = settledPolicy(),
): SettledDecision {
	if (facts.state === "working") return keep("working", "still working", true);
	if (facts.state === "waiting" || facts.pendingQuestion)
		return keep("needs-person", "waiting on the person", true);
	if (facts.work === "unpushed")
		return keep(
			"unpushed-work",
			"has committed or edited work that was not pushed",
			true,
		);
	if (facts.work === "unknown" && facts.pullRequest === "none")
		return keep(
			"work-unknown",
			"could not tell whether its work was pushed",
			true,
		);
	if (facts.pullRequest === "open")
		return keep(
			"open-pull-request",
			"its pull request is open and awaits a decision",
			true,
		);
	if (facts.pullRequest === "unknown")
		return keep(
			"pull-request-unknown",
			"its pull request state could not be checked",
			true,
		);
	const idleMs = Math.min(
		facts.settledAgeMs,
		facts.lastUserMessageAgeMs ?? Number.POSITIVE_INFINITY,
	);
	if (facts.work === "pushed" && facts.pullRequest === "none")
		return keep(
			"pushed-awaiting-merge",
			"its branch is pushed but not merged and has no pull request",
			true,
		);
	if (idleMs < SETTLED_DISCARD_IDLE_HOURS * HOUR_MS)
		return keep("recent-conversation", `active ${hoursText(idleMs)} ago`, true);
	if (facts.discard)
		return archive(
			facts.discard,
			`marked ${facts.discard}, idle ${hoursText(idleMs)}`,
		);
	if (facts.state === "failed")
		return archive(
			"failed",
			`failed, idle ${hoursText(idleMs)}, nothing unpushed`,
		);
	if (idleMs < policy.idleHours * HOUR_MS)
		return keep(
			"idle-not-long-enough",
			`idle ${hoursText(idleMs)} of ${policy.idleHours} h`,
			true,
		);
	if (facts.pullRequest === "merged" || facts.pullRequest === "closed")
		return archive(
			"landed",
			`pull request ${facts.pullRequest === "merged" ? "merged" : "merged or closed"}, idle ${hoursText(idleMs)}`,
		);
	if (facts.work === "landed")
		return archive("landed", `work landed, idle ${hoursText(idleMs)}`);
	if (facts.work === "none")
		return archive("no-changes", `no changes, idle ${hoursText(idleMs)}`);
	return keep("pushed-awaiting-merge", "its work is not merged", true);
}

/** The row of a thread as the sidebar lists it. */
export type SettledChat = {
	readonly waitingOn: string | null;
	readonly workingSince: string | null;
};

/** What the database adds (src/server/adapters/y-settled-facts.ts). */
export type SettledExtraFacts = {
	readonly lastUserAt: number | null;
	readonly unpushed: boolean;
	readonly pendingPush: boolean;
	readonly prUrl: string | null;
	readonly mayHaveChanged: boolean;
};

/**
 * The facts of one thread. `prOpen` is the GitHub answer for its pull request
 * (true open, false merged or closed, null could not be read; undefined: not
 * asked, read as unknown).
 */
export function settledFactsFor(input: {
	readonly chat: SettledChat;
	readonly extra: SettledExtraFacts;
	readonly updatedAt: number;
	readonly prOpen?: boolean | null;
	readonly now: number;
	readonly discard?: "duplicate" | "obsolete";
}): SettledFacts {
	const { chat, extra } = input;
	const state = chat.waitingOn
		? chat.waitingOn === "failed"
			? "failed"
			: "waiting"
		: chat.workingSince
			? "working"
			: "finished";
	const pullRequest: SettledPullRequest = extra.prUrl
		? input.prOpen === true
			? "open"
			: input.prOpen === false
				? "closed"
				: "unknown"
		: "none";
	const work: SettledWork = extra.unpushed
		? "unpushed"
		: extra.prUrl
			? "pushed"
			: extra.mayHaveChanged
				? "unknown"
				: "none";
	return {
		state,
		settledAgeMs: Math.max(0, input.now - input.updatedAt),
		lastUserMessageAgeMs:
			extra.lastUserAt === null
				? null
				: Math.max(0, input.now - extra.lastUserAt),
		pullRequest,
		work,
		pendingQuestion: extra.pendingPush,
		...(input.discard ? { discard: input.discard } : {}),
	};
}

/** The one-line report the person reads: counts only, never the threads. */
export function archiveSummaryLine(archived: number, kept: number): string {
	if (!archived) return "";
	const noun = archived === 1 ? "settled thread" : "settled threads";
	return kept
		? `Archived ${archived} ${noun}; kept ${kept} that still need a decision or may be reused.`
		: `Archived ${archived} ${noun}.`;
}

// ---------------------------------------------------------------- reuse

export type ReuseThread = {
	readonly id: string;
	readonly title: string;
	readonly lastRequest: string | null;
	/** Touched areas (project_trace areas), a few words each. */
	readonly areas: readonly string[];
	readonly pullRequest: string | null;
	readonly state: "working" | "waiting" | "failed" | "finished";
	/** Milliseconds since it settled. */
	readonly idleMs: number;
	/** The workspace machine still exists (not released by an archive or deleted). */
	readonly workspaceAlive: boolean;
	/** Transcript items: a proxy for how much context the thread carries. */
	readonly itemCount: number;
	readonly modelId: string | null;
};

export type ReuseTask = {
	readonly text: string;
	/** The task needs a clean checkout. */
	readonly cleanCheckout?: boolean;
	/** The task needs another model than the default. */
	readonly modelId?: string | null;
};

export type ReuseCandidate = {
	readonly id: string;
	readonly score: number;
	/** The relevance hint: why it fits. */
	readonly hint: string;
};

const FILLER = new Set(
	"the and for with that this from into then when what have will should make also just your about fix add update please thread task".split(
		" ",
	),
);

/** Lowercase words of 4+ characters, minus filler: the cheap relevance signal. */
export function reuseTokens(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]{3,}/g) ?? []).filter(
			(word) => !FILLER.has(word),
		),
	);
}

const prNumbers = (text: string) =>
	new Set(
		[...text.matchAll(/(?:#|pull\/|\bpr:?\s?)(\d{1,6})\b/gi)].map((m) => m[1]),
	);

/**
 * Threads worth messaging instead of starting a new one, best first, with a
 * hint each. Excluded outright: a working, waiting or failed thread, one whose
 * workspace is gone, one idle longer than REUSE_MAX_IDLE_HOURS, one carrying
 * more than REUSE_MAX_ITEMS items, a task that needs a clean checkout or a
 * different model than the thread runs. An unrelated thread (no shared word,
 * area or pull request) is never a candidate.
 */
export function reuseCandidates(
	task: ReuseTask,
	threads: readonly ReuseThread[],
): ReuseCandidate[] {
	if (task.cleanCheckout) return [];
	const wanted = reuseTokens(task.text);
	const wantedPrs = prNumbers(task.text);
	const found: ReuseCandidate[] = [];
	for (const thread of threads) {
		if (thread.state !== "finished" || !thread.workspaceAlive) continue;
		if (thread.idleMs > REUSE_MAX_IDLE_HOURS * HOUR_MS) continue;
		if (thread.itemCount > REUSE_MAX_ITEMS) continue;
		if (task.modelId && thread.modelId && task.modelId !== thread.modelId)
			continue;
		const own = reuseTokens(
			[thread.title, thread.lastRequest ?? "", ...thread.areas].join(" "),
		);
		const shared = [...wanted].filter((word) => own.has(word));
		const samePr =
			thread.pullRequest !== null &&
			[...prNumbers(thread.pullRequest)].some((n) => wantedPrs.has(n));
		const sharedAreas = thread.areas.filter((area) =>
			wanted.has(area.toLowerCase()),
		);
		if (!shared.length && !samePr && !sharedAreas.length) continue;
		const recency = 1 - thread.idleMs / (REUSE_MAX_IDLE_HOURS * HOUR_MS);
		const score =
			shared.length * 2 + sharedAreas.length * 3 + (samePr ? 6 : 0) + recency;
		const why = [
			samePr ? "same pull request" : null,
			sharedAreas.length
				? `same area: ${sharedAreas.slice(0, 2).join(", ")}`
				: null,
			shared.length ? `shares: ${shared.slice(0, 4).join(", ")}` : null,
			`idle ${hoursText(thread.idleMs)}`,
			"warm machine",
		].filter(Boolean);
		found.push({ id: thread.id, score, hint: why.join("; ") });
	}
	return found
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, REUSE_CANDIDATE_LIMIT);
}
