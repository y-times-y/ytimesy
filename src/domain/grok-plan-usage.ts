import type { PlanUsageBar } from "./plan-usage-bars";

/**
 * The Grok plan's (SuperGrok or X Premium) usage, as xAI's Grok CLI reads it
 * with the same OAuth token: `GET cli-chat-proxy.grok.com/v1/billing?format=credits`.
 * Unofficial and undocumented, so the body is read defensively. Its shape:
 *   { config: { creditUsagePercent, currentPeriod: { type, start, end },
 *     billingPeriodStart, billingPeriodEnd, productUsage: [{ product, usagePercent }] } }
 * where `type` is e.g. USAGE_PERIOD_TYPE_WEEKLY. Times here are epoch ms.
 */
export type GrokPlanUsage = {
	readonly windows: readonly GrokPlanWindow[];
	/** When the server read it. */
	readonly readAt: number;
};

export type GrokPlanWindow = {
	/** The period, lowercased: weekly, monthly, daily, or "plan" when unnamed. */
	readonly id: string;
	/** 0 to 100. */
	readonly usedPercent: number;
	readonly resetsAt: number | null;
};

export const GROK_PLAN_USAGE_URL =
	"https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const PERIOD_LABELS: Record<string, string> = {
	daily: "Day",
	weekly: "Week",
	monthly: "Month",
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function percent(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value)
		? Math.round(Math.max(0, Math.min(100, value)))
		: null;
}

function time(value: unknown): number | null {
	if (typeof value !== "string" || value.length > 64) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function periodId(type: unknown): string {
	if (typeof type !== "string") return "plan";
	const stem = /^USAGE_PERIOD_TYPE_([A-Z_]{1,20})$/.exec(type)?.[1];
	return stem ? stem.toLowerCase() : "plan";
}

/** The plan's reading from the billing body, or null when it carries none. */
export function grokPlanUsageFromBilling(
	body: unknown,
	now: number,
): GrokPlanUsage | null {
	const config = record(record(body)?.config);
	const usedPercent = percent(config?.creditUsagePercent);
	if (!config || usedPercent === null) return null;
	const period = record(config.currentPeriod);
	return {
		windows: [
			{
				id: periodId(period?.type),
				usedPercent,
				resetsAt: time(period?.end) ?? time(config.billingPeriodEnd),
			},
		],
		readAt: now,
	};
}

/** A stored reading, checked (it comes back from the database as JSON). */
export function grokPlanUsageFromJson(value: unknown): GrokPlanUsage | null {
	const stored = record(value);
	const readAt = stored?.readAt;
	if (
		typeof readAt !== "number" ||
		!Number.isFinite(readAt) ||
		!Array.isArray(stored?.windows)
	)
		return null;
	const windows = stored.windows.flatMap((entry): GrokPlanWindow[] => {
		const window = record(entry);
		const usedPercent = window?.usedPercent;
		if (
			!window ||
			typeof window.id !== "string" ||
			window.id.length > 20 ||
			typeof usedPercent !== "number" ||
			!(usedPercent >= 0 && usedPercent <= 100)
		)
			return [];
		const resetsAt =
			typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
				? window.resetsAt
				: null;
		return [{ id: window.id, usedPercent, resetsAt }];
	});
	return { windows, readAt };
}

/** The picker's bars. A window whose reset has passed since the reading starts over empty. */
export function grokPlanUsageBars(
	usage: GrokPlanUsage | null | undefined,
	now: number,
): PlanUsageBar[] {
	return (usage?.windows ?? []).map((window) => {
		const reset = window.resetsAt !== null && window.resetsAt <= now;
		return {
			id: window.id,
			label: PERIOD_LABELS[window.id] ?? "Plan",
			usedPercent: reset ? 0 : window.usedPercent,
			resetsAt: reset ? null : window.resetsAt,
		};
	});
}
