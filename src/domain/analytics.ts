import { z } from "zod";
import { harnessModelMetric, harnessToolMetric } from "./harness-performance";

const surface = z.enum(["workspace", "onboarding", "auth", "other"]);
const runtime = z.enum(["codex", "api"]);
const role = z.enum(["lead", "builder", "reader"]);
export const serverAnalyticsEvents = {
	harness_model_completed: harnessModelMetric.extend({
		runtime,
		role,
		model_key: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	harness_tool_completed: harnessToolMetric.extend({
		runtime,
		role,
		model_key: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	account_created: z.object({}),
	agent_created: z.object({ runtime, role }),
	turn_started: z.object({ runtime, role }),
	turn_finished: z.object({
		runtime,
		role,
		outcome: z.enum(["completed", "failed", "cancelled"]),
		duration_ms: z.number().finite().nonnegative().optional(),
	}),
	environment_started: z.object({ repositories: z.number().int().positive() }),
	environment_finished: z.object({
		outcome: z.enum(["ready", "failed"]),
	}),
	project_connected: z.object({ repositories: z.number().int().positive() }),
	pull_request_created: z.object({}),
};
export type ServerAnalyticsEvent = keyof typeof serverAnalyticsEvents;
export type ServerAnalyticsProperties<E extends ServerAnalyticsEvent> = z.input<
	(typeof serverAnalyticsEvents)[E]
>;
export const analyticsEvents = {
	app_viewed: z.object({ surface }),
	prompt_submitted: z.object({
		runtime: z.enum(["codex", "api"]),
		attempts: z.number().int().min(1).max(5),
	}),
	inspector_opened: z.object({
		panel: z.enum(["files", "diff", "terminal", "desktop"]),
	}),
};
export type AnalyticsEvent = keyof typeof analyticsEvents;
export type AnalyticsProperties<E extends AnalyticsEvent> = z.input<
	(typeof analyticsEvents)[E]
>;

export function analyticsSurface(pathname: string): z.infer<typeof surface> {
	if (pathname === "/") return "workspace";
	if (pathname === "/onboarding") return "onboarding";
	if (pathname.startsWith("/auth/")) return "auth";
	return "other";
}

/** Allow categories, never arbitrary text or SDK URL/referrer data. */
export function filteredAnalyticsProperties(
	event: string,
	properties: Record<string, unknown>,
): Record<string, unknown> | null {
	if (event === "$identify")
		return typeof properties.$anon_distinct_id === "string"
			? { $anon_distinct_id: properties.$anon_distinct_id }
			: {};
	if (!Object.hasOwn(analyticsEvents, event)) return null;
	const result = analyticsEvents[event as AnalyticsEvent].safeParse(properties);
	return result.success ? result.data : null;
}
