import { z } from "zod";
import type { SessionItem } from "./session-item";

/**
 * Real-user speed reports: Core Web Vitals from the `web-vitals` library and
 * the app's own interaction timings. Only categories and numbers: the route
 * is its template (never an id), the device a coarse class.
 */
export const analyticsRoutes = [
	"/",
	"/onboarding",
	"/auth/$path",
	"/projects/$projectId/evidence/$evidenceId",
	"/projects/$projectId/pulls/$linkId/fix",
	"/privacy",
	"/terms",
	"/training",
	"other",
] as const;
export type AnalyticsRoute = (typeof analyticsRoutes)[number];

/** The route template a path belongs to; ids are never kept. */
export function analyticsRoute(pathname: string): AnalyticsRoute {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	if (path === "/" || path === "") return "/";
	for (const fixed of [
		"/onboarding",
		"/privacy",
		"/terms",
		"/training",
	] as const)
		if (path === fixed) return fixed;
	if (/^\/auth\/[^/]+$/.test(path)) return "/auth/$path";
	if (/^\/projects\/[^/]+\/evidence\/[^/]+$/.test(path))
		return "/projects/$projectId/evidence/$evidenceId";
	if (/^\/projects\/[^/]+\/pulls\/[^/]+\/fix$/.test(path))
		return "/projects/$projectId/pulls/$linkId/fix";
	return "other";
}

export const deviceClasses = ["mobile", "tablet", "desktop"] as const;
export type DeviceClass = (typeof deviceClasses)[number];

/** Phone, tablet or desktop, from the viewport width and the pointer. */
export function deviceClass(input: {
	width: number;
	coarsePointer: boolean;
}): DeviceClass {
	if (input.width < 640) return "mobile";
	if (input.width < 1024 || (input.coarsePointer && input.width < 1366))
		return "tablet";
	return "desktop";
}

export const webVitalNames = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export const interactionTimings = [
	/** A chat picked in the sidebar until its transcript (or empty view) shows. */
	"chat_switch",
	/** The Files view opened until its tree shows. */
	"files_open",
	/** The Terminal view opened until the shell's first output. */
	"terminal_ready",
	/** A message sent until the agent's first output for it arrives. */
	"first_token",
] as const;
export type InteractionTiming = (typeof interactionTimings)[number];

/** Longest duration reported (10 minutes); longer is an abandoned page. */
export const MAX_REPORTED_MS = 600_000;

const route = z.enum(analyticsRoutes);
const device = z.enum(deviceClasses);
const milliseconds = z.number().finite().nonnegative().max(MAX_REPORTED_MS);

export const webVitalEvent = z.object({
	metric: z.enum(webVitalNames),
	// Milliseconds, except CLS (a unitless score).
	value: milliseconds,
	rating: z.enum(["good", "needs-improvement", "poor"]),
	navigation: z
		.enum([
			"navigate",
			"reload",
			"back-forward",
			"back-forward-cache",
			"prerender",
			"restore",
			"soft-navigation",
		])
		.optional(),
	route,
	device,
});

export const interactionTimingEvent = z.object({
	interaction: z.enum(interactionTimings),
	duration_ms: milliseconds,
	route,
	device,
});

/** Kinds that are the agent answering (not the user, nor app notices). */
const replyKinds = new Set<SessionItem["kind"]>([
	"agentMessage",
	"reasoning",
	"plan",
	"planProposal",
	"commandExecution",
	"fileChange",
	"mcpToolCall",
	"dynamicToolCall",
	"webSearch",
	"userQuestion",
]);

/** The agent's first output after the user message with this id has arrived. */
export function replyStartedAfter(
	items: readonly { readonly kind: SessionItem["kind"]; readonly id: string }[],
	userMessageId: string,
) {
	const at = items.findIndex(
		(item) => item.kind === "userMessage" && item.id === userMessageId,
	);
	if (at < 0) return false;
	for (const item of items.slice(at + 1)) {
		if (item.kind === "userMessage") return false;
		if (replyKinds.has(item.kind)) return true;
	}
	return false;
}
