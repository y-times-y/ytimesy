import { captureServerAnalytics } from "../adapters/analytics";

export function analyticsAgentRole(session: {
	readonly parentSessionId: string | null;
	readonly taskAccess: string | null;
}): "lead" | "builder" | "reader" {
	return !session.parentSessionId
		? "lead"
		: session.taskAccess === "read_write"
			? "builder"
			: "reader";
}

/** The session fields a turn event is categorized by; never prompt or reply text. */
export type TurnAnalyticsSession = {
	readonly userId: string;
	readonly harness: string;
	readonly parentSessionId: string | null;
	readonly taskAccess: string | null;
};

function turnProperties(session: TurnAnalyticsSession) {
	return {
		runtime: session.harness === "codex" ? "codex" : "api",
		role: analyticsAgentRole(session),
	} as const;
}

/** Recorded once per admitted turn, when its chat starts running. */
export function captureTurnStarted(
	session: TurnAnalyticsSession,
	turnId: string,
	startedAt: Date,
) {
	return captureServerAnalytics(
		session.userId,
		"turn_started",
		turnProperties(session),
		{ key: `turn:${turnId}:started`, timestamp: startedAt },
	);
}

/** Recorded once per settled turn; cancellation is a user stop, not a failure. */
export function captureTurnFinished(
	session: TurnAnalyticsSession,
	turnId: string,
	outcome: "completed" | "failed" | "cancelled",
	timing: { readonly startedAt: Date | null; readonly endedAt: Date },
) {
	const duration = timing.startedAt
		? timing.endedAt.getTime() - timing.startedAt.getTime()
		: Number.NaN;
	return captureServerAnalytics(
		session.userId,
		"turn_finished",
		{
			...turnProperties(session),
			outcome,
			...(Number.isFinite(duration)
				? { duration_ms: Math.max(0, duration) }
				: {}),
		},
		{ key: `turn:${turnId}:finished`, timestamp: timing.endedAt },
	);
}
