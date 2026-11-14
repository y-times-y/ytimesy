import {
	blockingUsageWindow,
	USAGE_WINDOW_WARNING_SHARE,
	type UsageAutoReset,
	type UsageWindowState,
} from "./infrastructure-usage";

export type UsageWarning = {
	readonly level: "warning" | "exhausted" | "reset";
	readonly window: UsageWindowState["id"];
	readonly usedPercent: number;
	readonly message: string;
	/** For a "reset" notice: when the window was reset (each reset is shown once). */
	readonly resetAt?: number;
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
		message: `You have used ${fullest.usedPercent}% of your ${WINDOW_NAMES[fullest.id]} cloud usage limit.${fullest.resetsAt ? ` It resets at ${label(fullest.resetsAt)}.` : ""} At the limit, running work finishes and new work waits.`,
	};
}

/**
 * For an account with the auto-reset policy: the notice it gets in place of
 * a refusal, about the latest window that was reset while an ordinary user
 * would still be waiting.
 */
export function autoResetNotice(
	resets: readonly UsageAutoReset[],
	label: (ms: number) => string = usageResetLabel,
): UsageWarning | null {
	const latest = [...resets].sort((a, b) => b.resetAt - a.resetAt)[0];
	if (!latest) return null;
	return {
		level: "reset",
		window: latest.id,
		usedPercent: 0,
		resetAt: latest.resetAt,
		message: `You reached your ${WINDOW_NAMES[latest.id]} cloud usage limit. Your account resets automatically, so it has been reset; a normal user would now wait ${latest.normalResetsAt ? `until ${label(latest.normalResetsAt)}` : "for it to reset"}.`,
	};
}

/**
 * What the user is shown about their cloud usage: the ordinary warning or
 * limit notice first (an auto-reset account sees exactly what anyone would),
 * else the notice of a recent auto-reset.
 */
export function usageNotice(
	usage: {
		readonly windows: readonly UsageWindowState[];
		readonly autoResets?: readonly UsageAutoReset[];
	},
	label: (ms: number) => string = usageResetLabel,
): UsageWarning | null {
	return (
		usageWarning(usage.windows, label) ??
		autoResetNotice(usage.autoResets ?? [], label)
	);
}
