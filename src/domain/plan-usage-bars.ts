import type { CodexUsage } from "./codex-usage";
import type { SessionItem } from "./session-item";

/** One ChatGPT plan window as a model picker bar; times in epoch ms. */
export type PlanUsageBar = {
	readonly id: string;
	readonly label: string;
	readonly usedPercent: number;
	readonly resetsAt: number | null;
};

/** A turn failed over because the plan's allowance was spent. */
export type PlanLimitReached = {
	/** When the plan said it resets (epoch ms), or null when it did not say. */
	readonly resetsAt: number | null;
	/** When we learned it (epoch ms). */
	readonly at: number;
};

const FIVE_HOURS_MS = 5 * 60 * 60_000;
/** How long a limit with no reset time keeps its window full. */
export const UNKNOWN_RESET_HOLD_MS = 60 * 60_000;
/** A limit's reset this close to a window's reset names that window. */
const SAME_RESET_MS = 15 * 60_000;

function windowLabel(minutes: number | null | undefined) {
	if (!minutes) return "Plan";
	if (minutes === 60 * 24 * 7) return "Week";
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

/** The Codex bucket's windows (5-hour, weekly), shortest first. */
export function planUsageBars(
	usage: CodexUsage | null | undefined,
): PlanUsageBar[] {
	const buckets = usage?.limits?.rateLimitsByLimitId;
	const bucket =
		buckets?.codex ??
		usage?.limits?.rateLimits ??
		(buckets ? Object.values(buckets)[0] : undefined);
	if (!bucket) return [];
	return [
		["primary", bucket.primary],
		["secondary", bucket.secondary],
	]
		.flatMap(([id, window]) =>
			window && typeof window === "object"
				? [
						{
							id: id as string,
							label: windowLabel(window.windowDurationMins),
							usedPercent: Math.round(window.usedPercent),
							resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
							minutes: window.windowDurationMins ?? 0,
						},
					]
				: [],
		)
		.sort((a, b) => a.minutes - b.minutes)
		.map(({ minutes: _minutes, ...bar }) => bar);
}

export function planLimitActive(limit: PlanLimitReached, now: number) {
	return limit.resetsAt !== null
		? limit.resetsAt > now
		: now - limit.at < UNKNOWN_RESET_HOLD_MS;
}

/** The window a spent allowance belongs to: the one resetting when the limit does. */
function spentWindowIndex(
	bars: readonly PlanUsageBar[],
	limit: PlanLimitReached,
	now: number,
) {
	const { resetsAt } = limit;
	if (resetsAt === null) {
		const most = Math.max(...bars.map((bar) => bar.usedPercent));
		return bars.findIndex((bar) => bar.usedPercent === most);
	}
	const nearest = bars
		.map((bar, index) => ({
			index,
			gap: bar.resetsAt === null ? Infinity : Math.abs(bar.resetsAt - resetsAt),
		}))
		.sort((a, b) => a.gap - b.gap)[0];
	if (nearest && nearest.gap <= SAME_RESET_MS) return nearest.index;
	// Past five hours away, only a longer window can be the spent one.
	return resetsAt - now > FIVE_HOURS_MS ? bars.length - 1 : 0;
}

/**
 * The bars with a just-hit limit shown as full until it resets, whatever an
 * older (or lagging) usage read says, so the picker never shows the plan as
 * available while turns fail over off it.
 */
export function withPlanLimitReached(
	bars: readonly PlanUsageBar[],
	limit: PlanLimitReached | null,
	now: number,
): PlanUsageBar[] {
	if (!limit || !planLimitActive(limit, now)) return [...bars];
	if (!bars.length)
		return [
			{
				id: "limit",
				label:
					limit.resetsAt !== null && limit.resetsAt - now > FIVE_HOURS_MS
						? "Week"
						: "5h",
				usedPercent: 100,
				resetsAt: limit.resetsAt,
			},
		];
	const spent = spentWindowIndex(bars, limit, now);
	return bars.map((bar, index) =>
		index === spent
			? { ...bar, usedPercent: 100, resetsAt: limit.resetsAt ?? bar.resetsAt }
			: bar,
	);
}

/** Usage-limit failovers in a transcript, by item id, with their reset times. */
export function planLimitSwitches(items: readonly SessionItem[]) {
	return items.flatMap((item) =>
		item.kind === "modelSwitch" && item.reason === "usage-limit"
			? [{ id: String(item.id), resetsAt: item.resetsAt ?? null }]
			: [],
	);
}
