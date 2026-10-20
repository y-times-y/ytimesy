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

/** "Tue 3:05 PM" in the reader's own zone. */
export function usageResetLabel(ms: number) {
	return new Date(ms).toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	});
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
