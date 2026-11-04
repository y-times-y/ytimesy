import { z } from "zod";
import { githubConnectionFailureReasons } from "./github-connection-callback";
import { harnessModelMetric, harnessToolMetric } from "./harness-performance";
import { interactionTimingEvent, webVitalEvent } from "./web-vitals";

/** Browser analytics path on our own origin (src/server/web/analytics-proxy.ts). */
export const ANALYTICS_PROXY_PATH = "/r";

const surface = z.enum(["workspace", "onboarding", "auth", "other"]);
const runtime = z.enum(["codex", "api"]);
const role = z.enum(["lead", "builder", "reader"]);
/** First-touch referral values, already bounded by referral-attribution.ts. */
const initialRef = z
	.string()
	.regex(/^[a-z0-9_-]{1,32}$/)
	.optional();
const initialValue = z
	.string()
	.regex(/^[a-z0-9._-]{1,64}$/)
	.optional();
/** Where the account first came from (user_attribution), when known. */
const initialAttribution = z.object({
	initial_ref: initialRef,
	initial_utm_source: initialValue,
	initial_utm_medium: initialValue,
	initial_utm_campaign: initialValue,
	initial_utm_content: initialValue,
	initial_utm_term: initialValue,
	initial_referrer_host: z
		.string()
		.regex(/^[a-z0-9.-]{1,100}$/)
		.optional(),
	initial_landing_path: z
		.string()
		.regex(/^\/[A-Za-z0-9/._~-]{0,119}$/)
		.optional(),
});
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
	/** The sign-up event (email, GitHub or Google), with its first touch. */
	account_created: initialAttribution,
	agent_created: z.object({ runtime, role }),
	turn_started: z.object({ runtime, role }),
	turn_finished: z.object({
		runtime,
		role,
		outcome: z.enum(["completed", "failed", "cancelled"]),
		duration_ms: z.number().finite().nonnegative().optional(),
	}),
	model_failover: z.object({
		runtime,
		role,
		reason: z.enum([
			"outage",
			"overloaded",
			"rate-limited",
			"usage-limit",
			"timeout",
			"plan-access",
			"signed-out",
			"out-of-credit",
			"key-refused",
		]),
		outcome: z.enum(["switched", "asked", "exhausted"]),
		same_model: z.boolean(),
		to_paid: z.boolean(),
	}),
	/** A Codex subscription request moved off a blocked network path. */
	codex_egress_failover: z.object({
		path: z.string().regex(/^(vpc|direct|relay-[1-8])$/),
		reason: z.enum([
			"challenge",
			"cloudflare-block",
			"forbidden-html",
			"unauthorized-html",
			"gateway-error",
			"redirect",
			"relay-unavailable",
			"transport",
			"timeout",
		]),
		outcome: z.enum(["switched", "exhausted"]),
	}),
	environment_started: z.object({ repositories: z.number().int().positive() }),
	environment_finished: z.object({
		outcome: z.enum(["ready", "failed"]),
	}),
	/** Onboarding, in order: where a new account stops (the browser may send nothing). */
	github_connect_started: z.object({}),
	github_connect_finished: z.object({
		outcome: z.enum(["connected", ...githubConnectionFailureReasons]),
	}),
	repositories_listed: z.object({
		repositories: z.number().int().nonnegative(),
	}),
	project_connected: z.object({ repositories: z.number().int().positive() }),
	pull_request_created: z.object({}),
};
export type ServerAnalyticsEvent = keyof typeof serverAnalyticsEvents;
export type ServerAnalyticsProperties<E extends ServerAnalyticsEvent> = z.input<
	(typeof serverAnalyticsEvents)[E]
>;
export const analyticsEvents = {
	app_viewed: z.object({
		surface,
		initial_ref: initialRef,
		initial_utm_source: initialValue,
	}),
	prompt_submitted: z.object({
		runtime: z.enum(["codex", "api"]),
		attempts: z.number().int().min(1).max(5),
	}),
	inspector_opened: z.object({
		panel: z.enum(["files", "diff", "terminal", "desktop"]),
	}),
	/** A Core Web Vital measured in this visitor's browser (web-vitals.ts). */
	web_vital: webVitalEvent,
	/** How long a key interaction took for this visitor (web-vitals.ts). */
	interaction_timing: interactionTimingEvent,
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
/**
 * The page a $pageview names, for PostHog's Web analytics: origin and path
 * only, with project pages collapsed to /projects (their ids are not
 * analytics). Sign-in pages are not counted (reset tokens live there).
 */
export function pageviewPath(pathname: string): string | null {
	if (pathname === "/auth" || pathname.startsWith("/auth/")) return null;
	if (pathname === "/projects" || pathname.startsWith("/projects/"))
		return "/projects";
	return pathname.slice(0, 200);
}

function pageviewProperties(
	properties: Record<string, unknown>,
): Record<string, unknown> | null {
	if (typeof properties.$current_url !== "string") return null;
	let url: URL;
	try {
		url = new URL(properties.$current_url);
	} catch {
		return null;
	}
	const path = pageviewPath(url.pathname);
	if (path === null) return null;
	const referrer = properties.$referring_domain;
	return {
		$current_url: `${url.origin}${path}`,
		$host: url.host,
		$pathname: path,
		...(typeof referrer === "string" &&
		/^[a-z0-9.-]{1,100}$|^\$direct$/.test(referrer)
			? { $referring_domain: referrer }
			: {}),
	};
}

export function filteredAnalyticsProperties(
	event: string,
	properties: Record<string, unknown>,
): Record<string, unknown> | null {
	if (event === "$pageview") return pageviewProperties(properties);
	if (event === "$identify")
		return typeof properties.$anon_distinct_id === "string"
			? { $anon_distinct_id: properties.$anon_distinct_id }
			: {};
	if (!Object.hasOwn(analyticsEvents, event)) return null;
	const result = analyticsEvents[event as AnalyticsEvent].safeParse(properties);
	return result.success ? result.data : null;
}
