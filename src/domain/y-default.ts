import type { ClaudePlanUsage } from "./claude-plan-usage";

/**
 * Y² is on by default (docs/y.md, "On by default"): every project has its
 * Super agent from the moment it is added, and it stays dormant (no wake, no
 * model turn, no error, no cost) until the person has a connected model that
 * can run it. These are the rules that keep that default harmless.
 */

/** The first line of a Super agent chat, written when the chat is created. */
export const Y_SQUARED_WELCOME =
	"I'm this project's Super agent. I keep track of its threads: what's working, what needs you and what finished with its pull request. Start a thread and I'll follow it. You can turn me off in Project settings > Y².";

/** Wakes per user per day across all their projects (each project also has its own 60/hour (120 with needs-you / failed) wake cap and 48/day proactive cap). */
export const Y_WAKES_PER_USER_PER_DAY = 600;

/** A plan this full gets no Y² wake: the person's own work comes first. */
export const PLAN_WAKE_STOP_PERCENT = 90;

/**
 * Whether the person's Claude plan is too full for a proactive Y² turn. A
 * rejected status, or any window past the stop line, skips the wake (it
 * costs nothing and shows nothing); no reading means no reason to skip.
 */
export function planBlocksWake(usage: ClaudePlanUsage | null): boolean {
	if (!usage) return false;
	if (usage.status === "rejected") return true;
	return usage.windows.some(
		(window) => window.usedPercent >= PLAN_WAKE_STOP_PERCENT,
	);
}

export type WakeSkipReason =
	| "no-model"
	| "plan-nearly-exhausted"
	| "user-daily-cap";
