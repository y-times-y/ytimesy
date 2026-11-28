/**
 * When the referral invitation may appear on its own. Pure; the state it reads
 * is kept per account (referral_prompt) and read with the referral summary.
 *
 * One warm-up invitation after a few completed turns, then only beside the
 * usage-limit notices: at most one per usage window, and quiet for a while
 * after a dismissal.
 */

export const REFERRAL_PROMPT_QUIET_DAYS = 7;
/** Completed turns before the one warm-up invitation. */
export const REFERRAL_WARMUP_MIN_TURNS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReferralPromptKind = "warmup" | "near_limit";

export type ReferralPromptFacts = {
	readonly enabled: boolean;
	/** The account's referrer rewards in the rolling period reached the cap. */
	readonly capped: boolean;
	/** The account joined through a link and already received its reset. */
	readonly rewardedAsReferred: boolean;
	readonly completedTurns: number;
	readonly warmupShownAt: string | null;
	readonly lastWindowKey: string | null;
	readonly dismissedAt: string | null;
	readonly turnRunning: boolean;
	/** The usage notice now: a heads-up (~80%), the limit reached, or none. */
	readonly notice: "warning" | "exhausted" | "reset" | null;
	/** Which usage window the notice is about (id and reset time). */
	readonly windowKey: string | null;
	readonly now: number;
};

export function decideReferralPrompt(
	facts: ReferralPromptFacts,
): ReferralPromptKind | null {
	if (
		!facts.enabled ||
		facts.turnRunning ||
		facts.capped ||
		facts.rewardedAsReferred
	)
		return null;
	if (
		facts.dismissedAt &&
		facts.now - new Date(facts.dismissedAt).getTime() <
			REFERRAL_PROMPT_QUIET_DAYS * DAY_MS
	)
		return null;
	if (facts.notice === "warning" || facts.notice === "exhausted")
		return facts.windowKey && facts.windowKey !== facts.lastWindowKey
			? "near_limit"
			: null;
	if (facts.notice) return null;
	return !facts.warmupShownAt &&
		facts.completedTurns >= REFERRAL_WARMUP_MIN_TURNS
		? "warmup"
		: null;
}
