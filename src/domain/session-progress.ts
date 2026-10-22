import type { SessionItem, SessionTurnStatus } from "./session-item";

/** When the live progress stream last delivered this chat's turn. */
export type LiveProgressMark = {
	readonly sessionId: string;
	readonly receivedAt: number;
} | null;

export function progressIsFresh(
	mark: LiveProgressMark,
	sessionId: string | null,
	now: number,
) {
	return Boolean(
		mark && mark.sessionId === sessionId && now - mark.receivedAt < 20_000,
	);
}

export type SessionProgress = {
	readonly usage?: CodexUsage;
	readonly sessionId: string;
	readonly items: readonly SessionItem[];
	readonly turnStatus: SessionTurnStatus;
};

/**
 * Snapshots replace text; reconnects never append a replayed delta twice.
 * A snapshot must hold every message the open chat shows (so one from before
 * a send never erases it); it may add later ones, such as the hidden message
 * that starts a wake-up turn after a helper's report or a command's exit.
 */
export function progressMatchesTurn(
	current: readonly SessionItem[],
	next: readonly SessionItem[],
) {
	const users = (items: readonly SessionItem[]) =>
		items.filter((item) => item.kind === "userMessage");
	const expected = users(current);
	const received = users(next);
	return (
		expected.length === 0 ||
		(received.length >= expected.length &&
			expected.at(-1)?.text === received[expected.length - 1]?.text)
	);
}

/**
 * A running snapshot of the turn the user just stopped (sent before the stop
 * settled) must not bring it back. A wake-up turn after it starts with a new
 * message, so it still shows.
 */
export function progressRevivesStoppedTurn(input: {
	readonly stopRequested: boolean;
	readonly current: readonly SessionItem[];
	readonly next: readonly SessionItem[];
	readonly nextStatus: SessionTurnStatus;
}): boolean {
	if (!input.stopRequested || input.nextStatus !== "running") return false;
	const users = (items: readonly SessionItem[]) =>
		items.filter((item) => item.kind === "userMessage" && !item.queued).length;
	return users(input.next) <= users(input.current);
}

/**
 * How long the open chat keeps listening after its last helper or background
 * command was seen to end: the report or exit notice starts Main's wake-up
 * turn on the server within this window (a queued report can lag its task).
 */
export const WAKE_WATCH_MS = 90_000;

/**
 * Whether the open chat listens on its live progress stream: while its own
 * turn runs, while its helpers work (each report wakes Main), and for a short
 * window after the last helper or background command ended. A chat with only
 * a long background command does not hold a stream; its exit, seen by the
 * commands read, opens the window. Idle chats hold nothing.
 */
export function progressStreamWanted(input: {
	readonly turnRunning: boolean;
	readonly helpersWorking: boolean;
	readonly watchingForWake: boolean;
}): boolean {
	return input.turnRunning || input.helpersWorking || input.watchingForWake;
}

import type { CodexUsage } from "./codex-usage";

/** A running chat's view is still re-read this often while its progress stream is open, to reconcile. */
export const LIVE_STREAM_RECONCILE_MS = 10_000;

/**
 * How often the open chat's view is re-read: every `pollMs` while its turn
 * runs without a live progress stream (the stream is how progress arrives
 * otherwise), rarely while one is open, never while idle.
 */
export function sessionReadInterval(input: {
	readonly polling: boolean;
	readonly streamOpen: boolean;
	readonly pollMs: number;
}): number | false {
	if (!input.polling) return false;
	return input.streamOpen ? LIVE_STREAM_RECONCILE_MS : input.pollMs;
}

/** A send that has not answered by then is reported, never left pending. */
export const SEND_TIMEOUT_MS = 30_000;
export const SEND_TIMEOUT_MESSAGE =
	"Sending is taking too long. Check your connection and retry.";

/** Rejects with `message` if `work` has not settled within `ms`. */
export function withinTimeout<T>(
	work: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
