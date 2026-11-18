const MAX_USAGE_MICRO_USD = 1_000_000_000_000;

export function validUsageAmount(amount: number) {
	if (
		!Number.isSafeInteger(amount) ||
		amount < 0 ||
		amount > MAX_USAGE_MICRO_USD
	)
		throw new Error("Invalid infrastructure usage amount.");
	return amount;
}

export function utcUsageMonth(now = new Date()) {
	if (!Number.isFinite(now.getTime())) throw new Error("Invalid usage date.");
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function infrastructureBalance(input: {
	allowanceMicroUsd: number;
	consumedMicroUsd: number;
	reservedMicroUsd: number;
}) {
	for (const value of Object.values(input)) validUsageAmount(value);
	return {
		...input,
		remainingMicroUsd: Math.max(
			0,
			input.allowanceMicroUsd - input.consumedMicroUsd - input.reservedMicroUsd,
		),
	};
}

/**
 * Per-user VM usage is limited over two windows that reset the way Claude's
 * do: a user's first usage after a window ends starts the next one, its
 * reset time is fixed then (5 hours or a week later), and at that time all
 * of its usage clears at once. Hitting either refuses new work; running
 * work finishes, up to a hard ceiling about an hour of runtime past the
 * limit.
 */
export const USAGE_WINDOWS = [
	{ id: "five_hour", label: "5-hour limit", ms: 5 * 60 * 60 * 1000 },
	{ id: "weekly", label: "Weekly limit", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;
export type UsageWindowId = (typeof USAGE_WINDOWS)[number]["id"];

export function usageWindowMs(id: UsageWindowId) {
	return USAGE_WINDOWS.find((window) => window.id === id)?.ms ?? 0;
}

/** Share of a window at which the user gets a heads-up. */
export const USAGE_WINDOW_WARNING_SHARE = 0.8;

/**
 * One reservation as usage, dated when its hold started (`at`): settled ones
 * at what they consumed, open holds (running machines) at their full held
 * amount. `settledAt` is when a settled one settled.
 */
export type UsageCharge = {
	at: number;
	microUsd: number;
	open: boolean;
	settledAt?: number | null;
};

export type UsageWindowState = {
	id: UsageWindowId;
	limitMicroUsd: number;
	usedMicroUsd: number;
	usedPercent: number;
	exhausted: boolean;
	/**
	 * When the current window resets and all of its usage clears: fixed when
	 * the window started. Null with no window running (the next usage starts
	 * one). Epoch milliseconds.
	 */
	resetsAt: number | null;
};

/**
 * Whether usage at `now` starts a new window: none has started yet, or the
 * last one has reset.
 */
export function usageWindowExpired(
	id: UsageWindowId,
	startedAt: number | null,
	now = Date.now(),
) {
	return startedAt === null || startedAt + usageWindowMs(id) <= now;
}

const sumCharges = (charges: readonly UsageCharge[]) =>
	charges.reduce((sum, charge) => sum + validUsageAmount(charge.microUsd), 0);

/**
 * A window's state from its start time and the user's charges: settled
 * usage counts from the window's start, and open holds (machines still
 * running) always count, so work in progress uses the current window.
 *
 * A window an auto-reset started (`carriedMicroUsd` set: see
 * resetUsageWindows) starts empty instead: holds that were open at the reset
 * count only for what they added since, which is their amount now (open, or
 * settled since the reset) less what they held then.
 */
export function usageWindowState(
	id: UsageWindowId,
	charges: readonly UsageCharge[],
	limitMicroUsd: number,
	startedAt: number | null,
	now = Date.now(),
	carriedMicroUsd: number | null = null,
): UsageWindowState {
	validUsageAmount(limitMicroUsd);
	const running = !usageWindowExpired(id, startedAt, now);
	const usedMicroUsd =
		running && startedAt !== null && carriedMicroUsd !== null
			? sumCharges(charges.filter((charge) => charge.at >= startedAt)) +
				Math.max(
					0,
					sumCharges(
						charges.filter(
							(charge) =>
								charge.at < startedAt &&
								(charge.open || (charge.settledAt ?? -1) >= startedAt),
						),
					) - validUsageAmount(carriedMicroUsd),
				)
			: sumCharges(
					charges.filter(
						(charge) =>
							charge.open ||
							(running && startedAt !== null && charge.at >= startedAt),
					),
				);
	return {
		id,
		limitMicroUsd,
		usedMicroUsd,
		usedPercent:
			limitMicroUsd > 0
				? Math.min(100, Math.floor((usedMicroUsd * 100) / limitMicroUsd))
				: 100,
		exhausted: usedMicroUsd >= limitMicroUsd,
		resetsAt:
			running && startedAt !== null ? startedAt + usageWindowMs(id) : null,
	};
}

/**
 * A user's charges summed by the database, per window, so a read returns one
 * row instead of every reservation of the week. Each sum is over the same
 * charge sets usageWindowState filters:
 * - `open`: open holds (counted whatever the window).
 * - `openOrSinceStart`: open holds plus charges dated at or after the start.
 * - `sinceStart`: charges dated at or after the start.
 * - `heldBeforeStart`: charges dated before the start that were open, or
 *   settled at or after it.
 */
export type UsageWindowSums = {
	open: number;
	openOrSinceStart: number;
	sinceStart: number;
	heldBeforeStart: number;
};

/** usageWindowState over precomputed sums: the same arithmetic, same result. */
export function usageWindowStateFromSums(
	id: UsageWindowId,
	sums: UsageWindowSums,
	limitMicroUsd: number,
	startedAt: number | null,
	now = Date.now(),
	carriedMicroUsd: number | null = null,
): UsageWindowState {
	validUsageAmount(limitMicroUsd);
	const running = !usageWindowExpired(id, startedAt, now);
	const usedMicroUsd =
		running && startedAt !== null && carriedMicroUsd !== null
			? sums.sinceStart +
				Math.max(0, sums.heldBeforeStart - validUsageAmount(carriedMicroUsd))
			: running && startedAt !== null
				? sums.openOrSinceStart
				: sums.open;
	return {
		id,
		limitMicroUsd,
		usedMicroUsd,
		usedPercent:
			limitMicroUsd > 0
				? Math.min(100, Math.floor((usedMicroUsd * 100) / limitMicroUsd))
				: 100,
		exhausted: usedMicroUsd >= limitMicroUsd,
		resetsAt:
			running && startedAt !== null ? startedAt + usageWindowMs(id) : null,
	};
}

/**
 * A window an auto-reset policy restarted (instead of refusing work), while
 * an ordinary user would still be waiting for it: `normalResetsAt` is when
 * the exhausted window would have reset (null when it had no reset time).
 */
export type UsageAutoReset = {
	id: UsageWindowId;
	resetAt: number;
	normalResetsAt: number | null;
};

/** The window that refuses new work now: the one that reopens last. */
export function blockingUsageWindow(windows: readonly UsageWindowState[]) {
	return (
		windows
			.filter((window) => window.exhausted)
			.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0] ?? null
	);
}

/** "2026-10-20 14:05 UTC": a server message cannot know the reader's zone. */
function utcMinute(ms: number) {
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Fixed wording; failure mapping recognizes it and shows it as is. */
export function usageWindowRefusal(window: UsageWindowState) {
	const which = window.id === "weekly" ? "weekly" : "5-hour";
	return `You have reached your ${which} cloud usage limit, so new work cannot start${window.resetsAt ? ` until ${utcMinute(window.resetsAt)}` : ""}. Work already running finishes, and your work is preserved.`;
}
export const USAGE_WINDOW_REFUSAL_PATTERN =
	/You have reached your (?:5-hour|weekly) cloud usage limit, so new work cannot start(?: until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)?\. Work already running finishes, and your work is preserved\./;

export class UsageWindowExhausted extends Error {
	constructor(readonly window: UsageWindowState) {
		super(usageWindowRefusal(window));
		this.name = "UsageWindowExhausted";
	}
}

/**
 * Running work may carry a window past its limit by about this much runtime
 * of the machine buying it, never further: it finishes its turn, but cannot
 * extend indefinitely.
 */
export const USAGE_OVERRUN_SECONDS = 3600;

/** The hard ceiling of a window for a machine costing hourlyMicroUsd. */
export function usageWindowCeiling(
	limitMicroUsd: number,
	hourlyMicroUsd: number,
) {
	validUsageAmount(hourlyMicroUsd);
	return (
		limitMicroUsd + Math.ceil((hourlyMicroUsd * USAGE_OVERRUN_SECONDS) / 3600)
	);
}

/** Fixed wording; failure mapping recognizes it and shows it as is. */
export function usageCeilingRefusal(window: UsageWindowState) {
	const which = window.id === "weekly" ? "weekly" : "5-hour";
	return `Running work has used the grace past your ${which} cloud usage limit, so this machine cannot keep running${window.resetsAt ? ` until ${utcMinute(window.resetsAt)}` : ""}. Your work is preserved.`;
}
export const USAGE_CEILING_REFUSAL_PATTERN =
	/Running work has used the grace past your (?:5-hour|weekly) cloud usage limit, so this machine cannot keep running(?: until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)?\. Your work is preserved\./;

export class UsageCeilingReached extends Error {
	constructor(readonly window: UsageWindowState) {
		super(usageCeilingRefusal(window));
		this.name = "UsageCeilingReached";
	}
}
