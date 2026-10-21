/**
 * Which hard-set records count toward the score. A record is scored when the
 * model had a fair attempt: graded, not skipped, full agent budget, and the
 * turn did not die of our infrastructure (coordination, heartbeat, the
 * subscription transport, a usage limit). Those are shown as "infra" and are
 * worth retrying; counting them as fails would blame the model for our outage.
 */
export type ScoredRecord = {
	readonly status: "final" | "grading" | "error" | "queued" | "running";
	readonly state: string;
	readonly usageLimit: string | null;
	readonly reward: number | null;
	readonly agentBudgetSec: number;
	readonly agentRequestedSec: number;
	readonly errors: readonly string[];
};

/** Turn errors raised by our platform, never by the model's work. */
const INFRA_ERRORS = [
	/Turn heartbeat or coordination service became unavailable/i,
	/Conversation coordination lease was lost/i,
	/conversation coordinator could not confirm this turn's ownership/i,
	/Selected subscription model is unavailable/i,
	/usage limit is used up|usage_limit_reached|Codex usage limit/i,
];

/** The infrastructure error that ended a failed turn, or null. */
export function infraFailure(record: ScoredRecord): string | null {
	if (record.usageLimit) return record.usageLimit;
	if (record.state !== "failed") return null;
	return (
		record.errors.find((error) =>
			INFRA_ERRORS.some((pattern) => pattern.test(error)),
		) ?? null
	);
}

export const isScored = (record: ScoredRecord) =>
	record.status === "final" &&
	record.state !== "skipped" &&
	infraFailure(record) === null &&
	record.reward !== null &&
	record.agentBudgetSec >= record.agentRequestedSec - 30;
