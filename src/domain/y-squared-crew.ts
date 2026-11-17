import type { SessionItem, SessionTurnStatus } from "./session-item";
import { type ChatWaitingOn, chatWaitingOn } from "./sidebar-chats";
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
/** Rows untouched this long are dropped. */
export const CREW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A wake for a finished turn (or a thread the person started) never comes
 * sooner than this after the note that asked for it, or the previous wake.
 */
export const CREW_WAKE_DELAY_MS = 10_000;
/** The same for a thread that needs the person or failed: they want it sooner. */
export const CREW_URGENT_WAKE_DELAY_MS = 5_000;
export const CREW_WAKES_PER_HOUR = 24;
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

/** How long a wake for this kind of change waits for more notes to coalesce. */
export function crewWakeDelayMs(state: CrewState | "started") {
	return state === "waiting" || state === "failed"
		? CREW_URGENT_WAKE_DELAY_MS
		: CREW_WAKE_DELAY_MS;
}

/** When a wake asked for at `now` is due: after its delay, and its delay after the previous wake. */
export function crewWakeDueAt(
	lastWakeAt: number,
	now: number,
	delayMs: number,
) {
	return Math.max(now + delayMs, lastWakeAt + delayMs);
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
				return `- The person started "${event.title}" themselves${detail}.`;
			default:
				return `- You were not part of this: "${event.title}" got a message from the person${detail}.`;
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
		"Call `threads`, then call `thread` for each one that finished or needs the person and give the person a short delta with the substance: what it found or built, the decision they need to make, who is still working and for how long. Never just say it finished; do not list everything again.",
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
	"state" | "waitingOn" | "prUrl" | "lastReply" | "lastRequest" | "title"
> {
	const waiting = chatWaitingOn(items, turnStatus);
	const facts = threadHistoryFacts(items);
	const pull = facts.pullRequest?.split(" ")[1] ?? null;
	const firstRequest = items.find(
		(item) => item.kind === "userMessage" && !("wake" in item && item.wake),
	);
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
		title:
			firstRequest && "text" in firstRequest ? text(firstRequest.text, 80) : "",
	};
}

/**
 * What a thread's start note tells the crew: the person's request this turn
 * began with (never a wake), from the transcript the chat object already
 * holds. Empty when the copy has no such message yet.
 */
export function crewRequestFromStartItems(items: readonly SessionItem[]) {
	const last = items.at(-1);
	if (!last || last.kind !== "userMessage" || ("wake" in last && last.wake))
		return null;
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
		title: row.title || "Untitled",
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
): { action: "none" | "send" | "capped"; next: WakeState; retryAt?: number } {
	const rolled =
		now - state.hourStart >= CREW_HOUR_MS
			? { ...state, hourStart: now, wakesThisHour: 0 }
			: state;
	const cleared = { ...rolled, alarmAt: null };
	if (!cleared.pending) return { action: "none", next: cleared };
	if (cleared.wakesThisHour >= CREW_WAKES_PER_HOUR)
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
