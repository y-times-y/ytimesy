import {
	type SessionItem,
	type SessionTurnStatus,
	sessionTitleFromText,
	UNTITLED_SESSION_TITLE,
} from "./session-item";
import { type ChatWaitingOn, chatWaitingOn } from "./sidebar-chats";
import { parsePeerMessage } from "./thread-peer";
import {
	type ThreadDigest,
	threadHistoryFacts,
	waitingOnText,
} from "./y-squared";
import { Y_SQUARED_QUIET_REPLY } from "./y-squared-proactive";

/**
 * Y²'s crew: one row per thread of a Y project, kept by the project's
 * YSquaredCrew Durable Object (src/server/edge/y-squared-crew.ts). Each
 * thread's own ModelConversation pushes a note when its turn starts and when
 * it settles; Y² reads the rows instead of every thread's transcript.
 */

export type CrewState = "working" | "waiting" | "finished" | "failed";

/** Longest last reply kept per thread. */
export const CREW_REPLY_LIMIT = 300;
/** Longest last request kept per thread. */
export const CREW_REQUEST_LIMIT = 200;
/** Longest canvas line a note carries. */
export const CREW_CANVAS_LIMIT = 200;
/** Longest question/secret line a waiting note carries. */
export const CREW_ASK_LIMIT = 360;
/** Most canvases one wake line names. */
const CREW_CANVAS_NAMED = 3;
/** Rows untouched this long are dropped. */
export const CREW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The first event after a quiet period wakes Y² at once: no debounce after
 * the note (it was 10 s for a finished turn, 5 s for needs-you / failed
 * until 2026-11-25). Only what arrives while Y² is already working is
 * batched (steered into its running turn, or one wake right after).
 */
export const CREW_WAKE_DELAY_MS = 0;
export const CREW_URGENT_WAKE_DELAY_MS = 0;
/** Notes closer than this to the previous wake coalesce into one wake (an identical burst). */
export const CREW_BURST_GAP_MS = 1_000;
/** Wakes per hour per project, for events that can wait (a finished turn, a started thread). */
export const CREW_WAKES_PER_HOUR = 60;
/**
 * Hard ceiling per hour per project, counting needs-you / failed wakes, which
 * are exempt from CREW_WAKES_PER_HOUR (a person waits on them) but still
 * bounded, so a thread that fails again and again cannot loop Y².
 */
export const CREW_URGENT_WAKES_PER_HOUR = 120;
/** A wake into a Y² that is mid-turn and cannot be steered is held and re-checked this often. */
export const CREW_BUSY_RECHECK_MS = 5_000;
/** ...for at most this long after its first event, then it queues behind the turn as before. */
export const CREW_BUSY_HOLD_MAX_MS = 5 * 60_000;
/** The part of a thread's final reply a wake carries (the row keeps CREW_REPLY_LIMIT). */
export const CREW_RESULT_LIMIT = 700;
/** The part of a failure reason a wake carries. */
export const CREW_FAILURE_LIMIT = 300;
/** A wake that could not be enqueued is tried again this many times in all. */
export const CREW_WAKE_RETRIES = 8;
/** The wait before retry `failures`: 30 s, 1 min, 2 min, then 5 min at most. */
export const wakeRetryDelayMs = (failures: number) =>
	Math.min(30_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000);
export const CREW_HOUR_MS = 60 * 60 * 1000;
/** A thread working this long with no wake since gets a "still working" heartbeat wake. */
export const CREW_HEARTBEAT_AFTER_MS = 5 * 60 * 1000;
/** Heartbeat wakes are at least this far apart, per project. */
export const CREW_HEARTBEAT_EVERY_MS = 10 * 60 * 1000;
/** A row working longer than this is taken for a lost settle note: no more heartbeats for it. */
export const CREW_WORKING_MAX_MS = 6 * 60 * 60 * 1000;
/** A thread the person started wakes Y² at most this often. */
export const CREW_STARTED_WAKE_EVERY_MS = 10 * 60 * 1000;
/** A send Y² made is remembered this long, to tell its threads' starts from the person's. */
export const CREW_Y2_SENT_TTL_MS = 60 * 60 * 1000;
/** Most wake events (what changed since the last wake) kept. */
export const CREW_EVENT_LIMIT = 12;

export type CrewNote = {
	readonly sessionId: string;
	readonly title: string;
	readonly state: CrewState;
	readonly waitingOn: string | null;
	readonly prUrl: string | null;
	readonly lastReply: string | null;
	/** What the person last asked the thread; absent on a start note and on older notes. */
	readonly lastRequest?: string | null;
	/**
	 * The canvases the settled turn showed or revised, as one line (title and
	 * revision only, never html). Told once in the wake; not kept in the rows.
	 */
	readonly canvas?: string | null;
	/**
	 * What a waiting thread asks, as one line: the question and its options, or
	 * the NAMES of the secrets it needs (never a value). Told once in the wake.
	 */
	readonly ask?: string | null;
	/** The final reply's first CREW_RESULT_LIMIT characters, told once in the wake (the row keeps 300). */
	readonly result?: string | null;
	/** Why a failed turn failed (the error's message, never its raw cause). */
	readonly failure?: string | null;
	/** Who to wake, and Y²'s own chat (never woken by its own notes). */
	readonly userId: string;
	readonly projectId: string;
	readonly ySquaredId: string | null;
};

const text = (value: unknown, limit: number) =>
	typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, limit)
		: "";

const STATES: readonly CrewState[] = [
	"working",
	"waiting",
	"finished",
	"failed",
];

/**
 * A note from the wire. Accepts the first deploy's older shapes too: a
 * `turnStatus` (running / completed / failed / idle) instead of `state`,
 * `pullRequest` for `prUrl`, `reply` for `lastReply`. Null when unusable.
 */
export function parseCrewNote(value: unknown): CrewNote | null {
	if (!value || typeof value !== "object") return null;
	const note = value as Record<string, unknown>;
	const sessionId = text(note.sessionId, 64);
	const userId = text(note.userId, 64);
	const projectId = text(note.projectId, 64);
	if (!sessionId || !userId || !projectId) return null;
	let state = note.state as CrewState | undefined;
	if (!state || !STATES.includes(state)) {
		const legacy = note.turnStatus;
		state =
			legacy === "running"
				? "working"
				: legacy === "failed"
					? "failed"
					: legacy === "completed" || legacy === "idle"
						? "finished"
						: undefined;
	}
	if (!state) return null;
	const waitingOn = text(note.waitingOn, 24) || null;
	return {
		sessionId,
		userId,
		projectId,
		state: waitingOn && state === "finished" ? "waiting" : state,
		title: text(note.title, 120),
		waitingOn,
		prUrl: text(note.prUrl ?? note.pullRequest, 300) || null,
		lastReply: text(note.lastReply ?? note.reply, CREW_REPLY_LIMIT) || null,
		lastRequest: text(note.lastRequest, CREW_REQUEST_LIMIT) || null,
		canvas: text(note.canvas, CREW_CANVAS_LIMIT) || null,
		ask: text(note.ask, CREW_ASK_LIMIT) || null,
		result: text(note.result, CREW_RESULT_LIMIT) || null,
		failure: text(note.failure, CREW_FAILURE_LIMIT) || null,
		ySquaredId: text(note.ySquaredId, 64) || null,
	};
}

/** A hint is only merged into a settle note that follows it this soon. */
export const CREW_WAITING_HINT_TTL_MS = 5 * 60 * 1000;

export type CrewWaitingHint = {
	readonly sessionId: string;
	readonly userId: string;
	readonly projectId: string;
	readonly ySquaredId: string | null;
	readonly waitingOn: string;
};

/** A waiting hint from the wire; null when unusable. */
export function parseCrewWaitingHint(value: unknown): CrewWaitingHint | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const sessionId = text(raw.sessionId, 64);
	const userId = text(raw.userId, 64);
	const projectId = text(raw.projectId, 64);
	const waitingOn = text(raw.waitingOn, 24);
	if (!sessionId || !userId || !projectId || !waitingOn) return null;
	return {
		sessionId,
		userId,
		projectId,
		waitingOn,
		ySquaredId: text(raw.ySquaredId, 64) || null,
	};
}

/** A thread's turn settled (finished, needs the person, failed) wakes Y²; plain progress does not. */
export function crewNoteMatters(state: CrewState) {
	return state !== "working";
}

/** How long a wake for this kind of change waits after its note: none. */
export function crewWakeDelayMs(state: CrewState | "started") {
	return state === "waiting" || state === "failed"
		? CREW_URGENT_WAKE_DELAY_MS
		: CREW_WAKE_DELAY_MS;
}

/** A change a person is waiting on: always wakes at once, outside the soft hourly cap. */
export const crewEventIsUrgent = (kind: string) =>
	kind === "waiting" || kind === "failed";

/** When a wake asked for at `now` is due: at once, unless the previous wake was under CREW_BURST_GAP_MS ago (then one wake covers the burst). */
export function crewWakeDueAt(
	lastWakeAt: number,
	now: number,
	delayMs: number,
) {
	return Math.max(now + delayMs, lastWakeAt + CREW_BURST_GAP_MS);
}

/**
 * When the next "still working" heartbeat is due, null when no thread is
 * working. A thread counts from its start or the last wake, whichever is
 * later, and a heartbeat follows the previous one by at least ten minutes.
 * Working rows older than six hours are ignored (a lost settle note).
 */
export function heartbeatDueAt(input: {
	readonly workingSince: readonly number[];
	readonly lastWakeAt: number;
	readonly lastHeartbeatAt: number;
	readonly now: number;
}): number | null {
	const live = input.workingSince.filter(
		(since) => input.now - since < CREW_WORKING_MAX_MS,
	);
	if (!live.length) return null;
	const quietSince = Math.max(Math.min(...live), input.lastWakeAt);
	return Math.max(
		quietSince + CREW_HEARTBEAT_AFTER_MS,
		input.lastHeartbeatAt + CREW_HEARTBEAT_EVERY_MS,
	);
}

/** One change since Y²'s last wake, told in the next wake's message. */
export type CrewWakeEvent = {
	readonly kind: CrewState | "started" | "direct";
	readonly title: string;
	/** The request (started, direct) or the pull request / what it waits on. */
	readonly detail: string | null;
};

const minutesText = (ms: number) =>
	`${Math.max(1, Math.round(ms / 60_000))} min`;

/** What Y² reads when a wake starts its turn: the change, and who is still working. Hidden from the chat. */
export function crewWakeBody(input: {
	readonly events: readonly CrewWakeEvent[];
	readonly working: readonly {
		readonly title: string;
		readonly since: number;
	}[];
	readonly now: number;
	/** Due schedules and stall signals (proactiveWakeLines). */
	readonly proactive?: readonly string[];
}) {
	const lines = input.events.map((event) => {
		const detail = event.detail ? ` (${event.detail})` : "";
		switch (event.kind) {
			case "finished":
				return `- "${event.title}" finished its turn${detail}.`;
			case "waiting":
				return `- "${event.title}" needs the person${detail}.`;
			case "failed":
				return `- "${event.title}" failed${detail}.`;
			case "started":
				return isPeerRequest(event.detail)
					? `- Another thread started "${event.title}" with a message, not the person${detail}.`
					: `- The person started "${event.title}" themselves${detail}.`;
			default:
				return isPeerRequest(event.detail)
					? `- You were not part of this: "${event.title}" got a message from another thread, not the person${detail}.`
					: `- You were not part of this: "${event.title}" got a message from the person${detail}.`;
		}
	});
	const working = input.working.map(
		(thread) =>
			`- "${thread.title}" still working, ${minutesText(input.now - thread.since)}.`,
	);
	const proactive = input.proactive ?? [];
	return [
		lines.length || working.length || !proactive.length
			? "Something changed in this project's threads."
			: "Proactive check-in: no thread changed.",
		...(lines.length ? ["Since your last report:", ...lines] : []),
		...(working.length ? ["Still working:", ...working] : []),
		...proactive,
		...(input.events.some((event) => event.detail?.includes("showed canvas"))
			? [
					"A thread showed a canvas: if it is a new revision of one you displayed here, call `show_canvas` again with the same title so the person sees it in this chat, and say what changed in one or two lines.",
				]
			: []),
		...(input.events.some((event) => event.detail?.includes("asks "))
			? [
					"A waiting thread's question and options are in its line above: put that question to the person yourself (one decision per message, with your recommendation); you need not read the thread to do it. Never ask for a secret's value in this chat: say which secret the thread needs and that the person enters it from the Needs you list beside this chat (or in the thread).",
				]
			: []),
		"Each line above carries what the thread said (its result, question and options, pull request, canvases, failure reason). Answer from those lines; call `thread` only for a thread whose line is cut off or not enough to act on, and `threads` only when you need the whole list. Give the person a short delta in at most 60 words: lead with what needs them (one decision, with your recommendation), then one line per thread that changed with its substance. Skip anything you already reported, do not re-list open decisions or still-working threads that did not change, and use no tables.",
		`If nothing here needs the person and nothing needs an action from you, reply with exactly ${Y_SQUARED_QUIET_REPLY} and nothing else: it shows no message.`,
	].join("\n");
}

/**
 * What a thread's settled turn tells Y², from the transcript the chat object
 * already holds (no database read): its state, what it waits on, its pull
 * request and last reply.
 */
export function crewFromSettledItems(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
): Pick<
	CrewNote,
	| "state"
	| "waitingOn"
	| "prUrl"
	| "lastReply"
	| "lastRequest"
	| "title"
	| "canvas"
	| "ask"
	| "result"
	| "failure"
> {
	const waiting = chatWaitingOn(items, turnStatus);
	const facts = threadHistoryFacts(items);
	const pull = facts.pullRequest?.split(" ")[1] ?? null;
	return {
		state:
			turnStatus === "failed" ? "failed" : waiting ? "waiting" : "finished",
		waitingOn: waiting,
		prUrl: pull,
		lastReply: facts.lastReply
			? facts.lastReply.slice(0, CREW_REPLY_LIMIT)
			: null,
		// The person's last request (never a wake), from the transcript the
		// chat object already holds.
		lastRequest: facts.lastRequest
			? facts.lastRequest.slice(0, CREW_REQUEST_LIMIT)
			: null,
		title: crewTitleFromItems(items),
		canvas: crewCanvasLine(items),
		ask: waiting ? crewAskLine(items) : null,
		result: crewFinalReply(items),
		failure: turnStatus === "failed" ? crewFailureReason(items) : null,
	};
}

/** The last agent message's first CREW_RESULT_LIMIT characters (the thread's result). */
export function crewFinalReply(items: readonly SessionItem[]): string | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage") break;
		if (item?.kind === "agentMessage" && item.text.trim())
			return text(item.text, CREW_RESULT_LIMIT) || null;
	}
	return null;
}

/** The message of the turn's last error item (not its raw cause). */
export function crewFailureReason(
	items: readonly SessionItem[],
): string | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item?.kind === "userMessage") break;
		if (item?.kind === "error")
			return text(item.message, CREW_FAILURE_LIMIT) || null;
	}
	return null;
}

/**
 * What the thread's open question or secret request says, in one line, from
 * the items the chat object already holds (no database read): the first
 * question with its option labels, or the secret NAMES. Never a secret value
 * (a request holds none) and never more than CREW_ASK_LIMIT characters.
 */
export function crewAskLine(items: readonly SessionItem[]): string | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item || item.kind === "userMessage") break;
		if (item.kind === "userQuestion") {
			const questions = item.questions ?? [];
			const first = questions[0];
			if (!first) return null;
			const more = questions.length - 1;
			return text(
				`asks "${text(first.question, 160)}" options: ${(first.options ?? [])
					.map((option) => text(option.label, 40))
					.join(
						" / ",
					)}${more > 0 ? ` (+${more} more question${more > 1 ? "s" : ""})` : ""}`,
				CREW_ASK_LIMIT,
			);
		}
		if (item.kind === "secretRequest") {
			const names =
				"secrets" in item
					? item.secrets.map((secret) => secret.name)
					: [item.name];
			return text(`asks for secrets ${names.join(", ")}`, CREW_ASK_LIMIT);
		}
	}
	return null;
}

/**
 * A thread's title as the sidebar shows it (`sessionTitleFromText`: the first
 * line of its first message, cut at 48 characters), so Y² and the person name
 * a thread the same way. Empty when there is none (no message yet, an
 * attachment only), never the "New session" placeholder.
 */
export function crewTitle(value: string | null | undefined): string {
	if (!value?.trim()) return "";
	const title = sessionTitleFromText(value);
	return title === UNTITLED_SESSION_TITLE ? "" : title;
}

/** The title of a chat whose transcript this is: from its first message the person (or Y²) sent, never a wake. */
export function crewTitleFromItems(items: readonly SessionItem[]): string {
	const first = items.find(
		(item) => item.kind === "userMessage" && !("wake" in item && item.wake),
	);
	return first && "text" in first ? crewTitle(first.text) : "";
}

/** A stored title, else one from the request: a row is never shown untitled when it has either. */
export function crewRowTitle(
	title: string,
	lastRequest: string | null | undefined,
): string {
	return title || crewTitle(lastRequest);
}

/**
 * What a thread's note says, from the transcript its chat object holds (or
 * the box turn's items). Every note carries a title, the start note too:
 * before, a start note carried none, so a new thread was "Untitled" to Y²
 * until its first turn settled, and for good when that note was lost.
 * `chatTitle` is the chat's own title (read with its crew scope), used when
 * the transcript has no message yet.
 */
export function crewNoteFromItems(
	items: readonly SessionItem[],
	turnStatus: SessionTurnStatus,
	chatTitle?: string | null,
): ReturnType<typeof crewFromSettledItems> {
	const derived =
		turnStatus === "running"
			? {
					state: "working" as const,
					waitingOn: null,
					prUrl: null,
					lastReply: null,
					// The request the turn began with: the crew tells Y² when the
					// person sent it to the thread directly.
					lastRequest: crewRequestFromStartItems(items),
					canvas: null,
					result: null,
					failure: null,
					title: crewTitleFromItems(items),
				}
			: crewFromSettledItems(items, turnStatus);
	return {
		...derived,
		title:
			derived.title || crewTitle(chatTitle) || crewTitle(derived.lastRequest),
	};
}

/**
 * The canvases the thread's last turn showed or revised, in one line:
 * `showed canvas "Thread art" (revision 2)`. From the items the chat
 * object already holds: titles and revision numbers, never html. Null when
 * the turn showed none.
 */
export function crewCanvasLine(items: readonly SessionItem[]): string | null {
	let start = 0;
	for (let index = items.length - 1; index >= 0; index--)
		if (items[index]?.kind === "userMessage") {
			start = index + 1;
			break;
		}
	const latest = new Map<string, number>();
	for (const item of items.slice(start))
		if (item.kind === "canvas")
			latest.set(
				item.title,
				Math.max(latest.get(item.title) ?? 0, item.revision),
			);
	if (!latest.size) return null;
	const named = [...latest]
		.slice(-CREW_CANVAS_NAMED)
		.map(
			([title, revision]) =>
				`canvas "${text(title, 60)}" (revision ${revision})`,
		);
	const more = latest.size - named.length;
	return text(
		`showed ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
		CREW_CANVAS_LIMIT,
	);
}

/**
 * What a thread's start note tells the crew: the person's request this turn
 * began with (never a wake), from the transcript the chat object already
 * holds. Empty when the copy has no such message yet.
 */
/** "thread", "captain" or "Super agent": the word before a peer sender's quoted name. */
const peerKindWord = (peer: {
	readonly kind: "thread" | "captain" | "leader";
}) => (peer.kind === "leader" ? "Super agent" : peer.kind);
/** A crew request that is another thread's, a captain's or the leader's message, not the person's. */
const isPeerRequest = (detail: string | null | undefined) =>
	/^From (thread|captain|Super agent) "/.test(detail ?? "");

export function crewRequestFromStartItems(items: readonly SessionItem[]) {
	const last = items.at(-1);
	if (!last || last.kind !== "userMessage" || ("wake" in last && last.wake))
		return null;
	// Another thread's message: say who sent it, not the wrapper's boilerplate.
	const peer = parsePeerMessage(last.text);
	if (peer)
		return (
			text(
				`From ${peerKindWord(peer)} "${peer.from}": ${peer.body}`,
				CREW_REQUEST_LIMIT,
			) || null
		);
	return text(last.text, CREW_REQUEST_LIMIT) || null;
}

export type CrewRow = {
	readonly sessionId: string;
	readonly title: string;
	readonly state: CrewState;
	readonly waitingOn: string | null;
	readonly prUrl: string | null;
	readonly lastReply: string | null;
	/** What the person last asked the thread (at most 200 characters). */
	readonly lastRequest: string | null;
	/** Last note of any kind. */
	readonly updatedAt: number;
	/** When the crew first noted the thread; 0: not recorded. */
	readonly createdAt: number;
	/** When the person or a wake last used the thread; 0: not recorded. */
	readonly lastActiveAt: number;
	/** When the thread's running turn started; null when it is not working. */
	readonly workingSince: number | null;
};

/** A crew row as the digest the threads tool prints. */
export function crewDigest(row: CrewRow, now: number): ThreadDigest {
	const needs = row.state === "waiting" || row.state === "failed";
	const waitingOn = (row.waitingOn ??
		(row.state === "failed" ? "failed" : null)) as ChatWaitingOn | null;
	return {
		id: row.sessionId,
		title: crewRowTitle(row.title, row.lastRequest) || "Untitled",
		status: needs ? "needs you" : row.state === "working" ? "working" : "idle",
		waitingOn: needs && waitingOn ? waitingOnText(waitingOn) : null,
		workingForMinutes:
			row.state === "working"
				? Math.max(
						0,
						Math.round((now - (row.workingSince ?? row.updatedAt)) / 60_000),
					)
				: null,
		lastRequest: row.lastRequest,
		lastReply: row.lastReply,
		pullRequest: row.prUrl,
		updatedAt: new Date(row.updatedAt).toISOString(),
		createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
		lastActiveAt: row.lastActiveAt
			? new Date(row.lastActiveAt).toISOString()
			: null,
	};
}

/** The wake bookkeeping row (wake_state). */
export type WakeState = {
	pending: boolean;
	lastWakeAt: number;
	wakesThisHour: number;
	hourStart: number;
	alarmAt: number | null;
};

/**
 * The alarm fired: send exactly one wake, or hold it until the hourly cap's
 * window rolls over. Pure; the store persists what it returns.
 */
export function decideWake(
	state: WakeState,
	now: number,
	/** A needs-you / failed change is in the wake: exempt from the soft cap, bounded by the hard one. */
	urgent = false,
): { action: "none" | "send" | "capped"; next: WakeState; retryAt?: number } {
	const rolled =
		now - state.hourStart >= CREW_HOUR_MS
			? { ...state, hourStart: now, wakesThisHour: 0 }
			: state;
	const cleared = { ...rolled, alarmAt: null };
	if (!cleared.pending) return { action: "none", next: cleared };
	if (
		cleared.wakesThisHour >=
		(urgent ? CREW_URGENT_WAKES_PER_HOUR : CREW_WAKES_PER_HOUR)
	)
		return {
			action: "capped",
			next: cleared,
			retryAt: cleared.hourStart + CREW_HOUR_MS,
		};
	return {
		action: "send",
		next: {
			...cleared,
			pending: false,
			wakesThisHour: cleared.wakesThisHour + 1,
			lastWakeAt: now,
		},
	};
}

/**
 * Whether a thread's chat object tells the crew at all: only a chat of a
 * project with Y on, and never Y² itself. Everything else sends nothing.
 */
export function crewProjectFor(
	scope: {
		readonly projectId: string | null;
		readonly yEnabled: boolean;
		readonly ySquaredId: string | null;
	} | null,
	sessionId: string,
): string | null {
	if (!scope?.yEnabled || !scope.projectId) return null;
	return scope.ySquaredId === sessionId ? null : scope.projectId;
}
