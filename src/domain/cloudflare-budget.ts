/**
 * Self-enforced Cloudflare Workers Paid budget (docs/cloudflare-budget.md).
 * Cloudflare has no hard cap, so usage is metered per user and per UTC month
 * and new turns are degraded, then held, before the plan's included
 * allowances are crossed. Pure: no I/O, no clock, no environment reads
 * except what the caller passes in.
 */

/** Memory every Durable Object is billed at for duration (GB-s). */
export const DO_BILLED_MEMORY_MB = 128;
/** One hibernatable WebSocket message bills as 1/20 of a request. */
export const WS_MESSAGES_PER_REQUEST = 20;

export type CloudflareBudget = {
	/** Durable Object duration, GB-s per user per month. */
	doGbSeconds: number;
	/** Durable Object requests per user per month. */
	doRequests: number;
	/** Worker requests per user per month. */
	workerRequests: number;
	/** Percent of any budget at which new turns degrade (blocked at 100). */
	degradePercent: number;
};

/** 100 heavy users on the included allowances (400k GB-s, 1M DO req, 10M Worker req). */
export const DEFAULT_CLOUDFLARE_BUDGET: CloudflareBudget = {
	doGbSeconds: 4_000,
	doRequests: 10_000,
	workerRequests: 100_000,
	degradePercent: 70,
};

export type BudgetUsage = {
	/** Wall-clock milliseconds a Durable Object was active (alarm steps). */
	wallMs: number;
	/** fetch() requests into a Durable Object. */
	requests: number;
	/** Hibernatable WebSocket messages received. */
	wsMsgs: number;
	/** Alarm invocations (each bills as a request). */
	alarms: number;
	/** Worker requests, when measured. */
	workerRequests?: number;
};

export const EMPTY_USAGE: BudgetUsage = {
	wallMs: 0,
	requests: 0,
	wsMsgs: 0,
	alarms: 0,
};

export type BudgetState = "ok" | "degrade" | "blocked";
export type GlobalBudgetMode = "off" | "degrade" | "pause";

function positive(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return value?.trim() && Number.isFinite(parsed) && parsed > 0
		? parsed
		: fallback;
}

/** Budgets from `YTIMESY_CF_BUDGET_*`; unset or invalid values keep the defaults. */
export function cloudflareBudgetFromEnv(
	env: Record<string, string | undefined>,
): CloudflareBudget {
	const degrade = positive(
		env.YTIMESY_CF_BUDGET_DEGRADE_PERCENT,
		DEFAULT_CLOUDFLARE_BUDGET.degradePercent,
	);
	return {
		doGbSeconds: positive(
			env.YTIMESY_CF_BUDGET_DO_GB_SECONDS,
			DEFAULT_CLOUDFLARE_BUDGET.doGbSeconds,
		),
		doRequests: positive(
			env.YTIMESY_CF_BUDGET_DO_REQUESTS,
			DEFAULT_CLOUDFLARE_BUDGET.doRequests,
		),
		workerRequests: positive(
			env.YTIMESY_CF_BUDGET_WORKER_REQUESTS,
			DEFAULT_CLOUDFLARE_BUDGET.workerRequests,
		),
		degradePercent: Math.min(degrade, 100),
	};
}

/**
 * `YTIMESY_CF_BUDGET_USERS`: the users whose compute is metered and held to
 * their monthly budget (comma separated ids; "*" is everyone). Unset or empty
 * means nobody: the per-user budget is off. Same style as boxTurnUsers().
 */
export function cloudflareBudgetUsers(
	value: string | undefined,
): ReadonlySet<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
}

/** Whether this user's compute is metered and budgeted. */
export function budgetAppliesTo(
	users: ReadonlySet<string>,
	userId: string | null | undefined,
): boolean {
	return !!userId && (users.has("*") || users.has(userId));
}

/** `YTIMESY_CF_BUDGET_GLOBAL`: anything but degrade or pause means off. */
export function globalBudgetMode(value: string | undefined): GlobalBudgetMode {
	const mode = value?.trim().toLowerCase();
	return mode === "degrade" || mode === "pause" ? mode : "off";
}

/** GB-s billed for this much wall time at the billed memory size. */
export function gbSecondsFromWallMs(wallMs: number): number {
	if (!Number.isFinite(wallMs) || wallMs <= 0) return 0;
	return (wallMs / 1000) * (DO_BILLED_MEMORY_MB / 1024);
}

/** Durable Object requests as billed: fetches, alarms and a twentieth of WebSocket messages. */
export function billedDoRequests(usage: BudgetUsage): number {
	return (
		usage.requests +
		usage.alarms +
		Math.ceil(usage.wsMsgs / WS_MESSAGES_PER_REQUEST)
	);
}

/** Fraction (1 = at budget) of each resource, and the largest. */
export function budgetFractions(
	usage: BudgetUsage,
	budget: CloudflareBudget = DEFAULT_CLOUDFLARE_BUDGET,
) {
	const duration = gbSecondsFromWallMs(usage.wallMs) / budget.doGbSeconds;
	const requests = billedDoRequests(usage) / budget.doRequests;
	const worker =
		usage.workerRequests === undefined
			? 0
			: usage.workerRequests / budget.workerRequests;
	return {
		duration,
		requests,
		worker,
		max: Math.max(duration, requests, worker),
	};
}

/** ok below the degrade percent, degrade from it, blocked at 100% of any budget. */
export function budgetState(
	usage: BudgetUsage,
	budget: CloudflareBudget = DEFAULT_CLOUDFLARE_BUDGET,
): BudgetState {
	const { max } = budgetFractions(usage, budget);
	if (!(max < 1)) return "blocked";
	return max >= budget.degradePercent / 100 ? "degrade" : "ok";
}

/** UTC month, e.g. "2026-11": the budget period. Resets on the 1st. */
export function budgetPeriodKey(at: number | Date): string {
	const date = typeof at === "number" ? new Date(at) : at;
	return date.toISOString().slice(0, 7);
}

/** UTC day, e.g. "2026-11-16": usage rows are kept per day. */
export function budgetDayKey(at: number | Date): string {
	const date = typeof at === "number" ? new Date(at) : at;
	return date.toISOString().slice(0, 10);
}

export const BUDGET_BLOCKED_MESSAGE =
	"Monthly compute budget reached, resets on the 1st";
export const BUDGET_DEGRADED_MESSAGE =
	"Monthly compute budget is nearly used; background work is reduced until it resets on the 1st";
export const BUDGET_PAUSED_MESSAGE =
	"New turns are paused for maintenance; your message stays queued and starts when they resume";

/** The text for a state, or null when nothing needs saying. */
export function budgetMessage(state: BudgetState): string | null {
	if (state === "blocked") return BUDGET_BLOCKED_MESSAGE;
	if (state === "degrade") return BUDGET_DEGRADED_MESSAGE;
	return null;
}

export type TurnAdmission = {
	/** hold: leave the turn queued; start: begin it, in degraded mode if asked. */
	action: "start" | "hold";
	degraded: boolean;
	message: string | null;
};

/**
 * What to do with a turn about to start. A turn already running is never
 * asked about. An unreadable state (null) fails open.
 */
export function turnAdmission(
	state: BudgetState | null,
	mode: GlobalBudgetMode = "off",
): TurnAdmission {
	if (mode === "pause")
		return { action: "hold", degraded: true, message: BUDGET_PAUSED_MESSAGE };
	if (state === "blocked")
		return {
			action: "hold",
			degraded: true,
			message: BUDGET_BLOCKED_MESSAGE,
		};
	const degraded = mode === "degrade" || state === "degrade";
	return {
		action: "start",
		degraded,
		message: degraded ? BUDGET_DEGRADED_MESSAGE : null,
	};
}

/** Cloudflare's refusal once an account spending limit is hit (best effort match). */
export function isSpendingCapError(error: unknown): boolean {
	try {
		const text = error instanceof Error ? error.message : String(error);
		return /spending (cap|limit)|exceeded (the )?account'?s? (spending|usage)|billing limit/i.test(
			text,
		);
	} catch {
		return false;
	}
}
