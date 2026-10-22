import {
	blockingUsageWindow,
	USAGE_WINDOW_WARNING_SHARE,
	type UsageWindowState,
} from "./infrastructure-usage";

export type UsageWarning = {
	readonly level: "warning" | "exhausted";
	readonly window: UsageWindowState["id"];
	readonly usedPercent: number;
	readonly message: string;
};

const WINDOW_NAMES = { five_hour: "5-hour", weekly: "weekly" } as const;

/**
 * "Fri, Oct 23, 3:15 AM (in 2 days)" in the reader's own zone. The zone and
 * locale are parameters only so tests can pin them.
 */
export function usageResetLabel(
	ms: number,
	now: number = Date.now(),
	zone: { readonly locale?: string; readonly timeZone?: string } = {},
) {
	const when = new Date(ms).toLocaleString(zone.locale, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: zone.timeZone,
	});
	const relative = relativeTime(ms - now, zone.locale);
	return relative ? `${when} (${relative})` : when;
}

/** "in 20 minutes", "in 5 hours", "in 2 days"; null once the time has passed. */
function relativeTime(deltaMs: number, locale?: string) {
	const minutes = Math.round(deltaMs / 60_000);
	if (minutes < 1) return null;
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
	if (minutes < 60) return format.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 24) return format.format(hours, "hour");
	return format.format(Math.round(hours / 24), "day");
}

/**
 * A heads-up once either cloud usage window passes 80%, and a notice when
 * one is exhausted. Held usage (running machines) counts as used. Reaching a
 * limit never stops running work; it only holds back new work.
 */
export function usageWarning(
	windows: readonly UsageWindowState[],
	label: (ms: number) => string = usageResetLabel,
): UsageWarning | null {
	const blocking = blockingUsageWindow(windows);
	if (blocking)
		return {
			level: "exhausted",
			window: blocking.id,
			usedPercent: 100,
			message: `You have reached your ${WINDOW_NAMES[blocking.id]} cloud usage limit. Running work finishes; new work can start again${blocking.resetsAt ? ` at ${label(blocking.resetsAt)}` : " soon"}.`,
		};
	const fullest = [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
	if (!fullest || fullest.usedPercent < USAGE_WINDOW_WARNING_SHARE * 100)
		return null;
	return {
		level: "warning",
		window: fullest.id,
		usedPercent: fullest.usedPercent,
		message: `You have used ${fullest.usedPercent}% of your ${WINDOW_NAMES[fullest.id]} cloud usage limit.${fullest.resetsAt ? ` It starts to refill at ${label(fullest.resetsAt)}.` : ""} At the limit, running work finishes and new work waits.`,
	};
}
