import type { SessionItem, SessionTurnStatus } from "./session-item";
import { type ChatWaitingOn, chatWaitingOn } from "./sidebar-chats";
import {
	type ThreadDigest,
	threadHistoryFacts,
	waitingOnText,
} from "./y-squared";

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
/** A wake never comes sooner than this after the note that asked for it, or the previous wake. */
export const CREW_WAKE_DELAY_MS = 45_000;
export const CREW_WAKES_PER_HOUR = 12;
export const CREW_HOUR_MS = 60 * 60 * 1000;

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

/** Finished, needing the person or failed wake Y²; plain progress does not. */
export function crewNoteMatters(state: CrewState) {
	return state !== "working";
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
				? Math.max(0, Math.round((now - row.updatedAt) / 60_000))
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

/** When the alarm for a note that matters should fire, null when one is set already. */
export function wakeAlarmAt(state: WakeState, now: number) {
	if (!state.pending || state.alarmAt !== null) return null;
	return Math.max(
		now + CREW_WAKE_DELAY_MS,
		state.lastWakeAt + CREW_WAKE_DELAY_MS,
	);
}

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
