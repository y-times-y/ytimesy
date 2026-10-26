/**
 * The grind budget (harness variant grind=on, unattended runs): agents tend
 * to stop well inside their time budget, and nobody reviews the work before
 * it is graded. When the root builder finishes before the minimum share of
 * the trial's time has passed, it is sent back, at most GRIND_MAX_ROUNDS
 * times, to try to break its own result. The notice is generic: it names no
 * task, check or known failure.
 */

/** Continuations per trial at most. */
export const GRIND_MAX_ROUNDS = 2;

/** The builder may finish once this much of the trial's time has passed: a quarter, at most an hour. */
export function grindMinimumMs(budgetMs: number) {
	return Math.min(0.25 * Math.max(0, budgetMs), 60 * 60_000);
}

/** No continuation when less than this is left: the agent needs time to act. */
export const GRIND_MIN_REMAINING_MS = 15 * 60_000;

export function grindNotice(input: {
	startedAtMs: number;
	nowMs: number;
	deadlineAtMs: number;
	/** Continuations already sent. */
	rounds: number;
}): string | null {
	if (input.rounds >= GRIND_MAX_ROUNDS) return null;
	const elapsed = input.nowMs - input.startedAtMs;
	const remaining = input.deadlineAtMs - input.nowMs;
	const budget = input.deadlineAtMs - input.startedAtMs;
	if (remaining < GRIND_MIN_REMAINING_MS) return null;
	if (elapsed >= grindMinimumMs(budget)) return null;
	const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
	return [
		`Runtime notice, not a new user request. You finished after ${minutes(elapsed)} minutes; ${minutes(remaining)} minutes remain and nobody will review this work before it is graded.`,
		"Use the time to try to break your result before finishing:",
		"- Re-read the request sentence by sentence and confirm each requirement with a command you run on the final deliverable, not from memory.",
		"- Exercise every stated symptom, example and edge case the request or its files describe, through the same interfaces and paths a user would call.",
		"- Check outputs against the inputs they came from; where an assumption or reading changes the result, test the other reading too.",
		"Fix what you find. When everything holds under real checks, finish again with a brief answer.",
	].join("\n");
}
