import type { SessionItem, SessionTurnStatus } from "./session-item";

export type LiveProgressMarks = Partial<
	Record<
		"main" | "side",
		{
			readonly sessionId: string;
			readonly receivedAt: number;
		}
	>
>;

export function progressIsFresh(
	marks: LiveProgressMarks | null,
	lane: "main" | "side",
	sessionId: string | null,
	now: number,
) {
	const mark = marks?.[lane];
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

/** Snapshots replace text; reconnects never append a replayed delta twice. */
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
			expected.at(-1)?.text === received.at(-1)?.text)
	);
}

import type { CodexUsage } from "./codex-usage";
