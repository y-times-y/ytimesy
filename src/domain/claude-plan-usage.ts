import { type PlanUsageBar, withPlanLimitReached } from "./plan-usage-bars";

/**
 * The Claude plan's usage as Anthropic reports it on every model response
 * to a subscription (OAuth) token, in the `anthropic-ratelimit-unified-*`
 * headers. These are the names Claude Code itself reads: `-status`,
 * `-reset` (epoch seconds), and per window `-5h-` / `-7d-` `utilization`
 * (a fraction, 0 to 1) and `reset` (epoch seconds). Times here are epoch ms.
 */
export type ClaudePlanUsage = {
	/** allowed, allowed_warning or rejected. */
	readonly status: string | null;
	readonly resetsAt: number | null;
	readonly windows: readonly ClaudePlanWindow[];
	/** When the edge saw these headers. */
	readonly readAt: number;
};

export type ClaudePlanWindow = {
	readonly id: "5h" | "7d";
	/** 0 to 100. */
	readonly usedPercent: number;
	readonly resetsAt: number | null;
};

const HEADER = "anthropic-ratelimit-unified";
const WINDOWS = ["5h", "7d"] as const;

function epochMs(value: string | null) {
	const seconds = Number(value);
	return value && Number.isFinite(seconds) && seconds > 0
		? seconds * 1000
		: null;
}

/** The plan's reading from a response's headers, or null when it carries none. */
export function claudePlanUsageFromHeaders(
	headers: Headers,
	now: number,
): ClaudePlanUsage | null {
	const windows = WINDOWS.flatMap((id) => {
		const raw = headers.get(`${HEADER}-${id}-utilization`);
		const utilization = Number(raw);
		if (raw === null || raw.trim() === "" || !Number.isFinite(utilization))
			return [];
		return [
			{
				id,
				usedPercent: Math.round(Math.max(0, Math.min(1, utilization)) * 100),
				resetsAt: epochMs(headers.get(`${HEADER}-${id}-reset`)),
			},
		];
	});
	const status = headers.get(`${HEADER}-status`)?.slice(0, 40) ?? null;
	if (!windows.length && status === null) return null;
	return {
		status,
		resetsAt: epochMs(headers.get(`${HEADER}-reset`)),
		windows,
		readAt: now,
	};
}

/** A stored reading, checked (it comes back from the database as JSON). */
export function claudePlanUsageFromJson(
	value: unknown,
): ClaudePlanUsage | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const time = (field: unknown) =>
		typeof field === "number" && Number.isFinite(field) ? field : null;
	const readAt = time(record.readAt);
	if (readAt === null || !Array.isArray(record.windows)) return null;
	const windows = record.windows.flatMap((entry): ClaudePlanWindow[] => {
		if (!entry || typeof entry !== "object") return [];
		const window = entry as Record<string, unknown>;
		const usedPercent = time(window.usedPercent);
		if (
			(window.id !== "5h" && window.id !== "7d") ||
			usedPercent === null ||
			usedPercent < 0 ||
			usedPercent > 100
		)
			return [];
		return [{ id: window.id, usedPercent, resetsAt: time(window.resetsAt) }];
	});
	return {
		status: typeof record.status === "string" ? record.status : null,
		resetsAt: time(record.resetsAt),
		windows,
		readAt,
	};
}

/**
 * The picker's bars: 5h then Week. A window whose reset has passed since the
 * reading starts over empty; a rejected reading shows its window as spent.
 */
export function claudePlanUsageBars(
	usage: ClaudePlanUsage | null | undefined,
	now: number,
): PlanUsageBar[] {
	if (!usage) return [];
	const bars = usage.windows.map((window) => {
		const reset = window.resetsAt !== null && window.resetsAt <= now;
		return {
			id: window.id,
			label: window.id === "5h" ? "5h" : "Week",
			usedPercent: reset ? 0 : window.usedPercent,
			resetsAt: reset ? null : window.resetsAt,
		};
	});
	return usage.status === "rejected"
		? withPlanLimitReached(
				bars,
				{ resetsAt: usage.resetsAt, at: usage.readAt },
				now,
			)
		: bars;
}
