import type { Metric } from "web-vitals";
import {
	analyticsRoute,
	deviceClass,
	type InteractionTiming,
	MAX_REPORTED_MS,
} from "#/domain/web-vitals";
import { captureAnalytics } from "./client";

/**
 * Real-user speed: Core Web Vitals and the app's key interaction timings, sent
 * as product events through the analytics client (same consent and privacy
 * filter as every other event: route template, device class, numbers).
 */

function currentDevice() {
	let coarsePointer = false;
	try {
		coarsePointer = window.matchMedia("(pointer: coarse)").matches;
	} catch {
		// Older browsers: decide by width alone.
	}
	return deviceClass({ width: window.innerWidth, coarsePointer });
}

const clampMs = (value: number) =>
	Math.min(MAX_REPORTED_MS, Math.max(0, Math.round(value)));

let vitalsStarted = false;
/**
 * Reports LCP, INP, CLS, FCP and TTFB once each is final (web-vitals reports
 * INP and CLS when the page is hidden). The library loads after the page,
 * off the critical path. The route is the page the visit landed on.
 */
export function startWebVitals() {
	if (vitalsStarted || typeof window === "undefined") return;
	vitalsStarted = true;
	const route = analyticsRoute(window.location.pathname);
	void import("web-vitals")
		.then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
			const report = (metric: Metric) => {
				if (!Number.isFinite(metric.value)) return;
				captureAnalytics("web_vital", {
					metric: metric.name,
					value:
						metric.name === "CLS"
							? Math.round(metric.value * 10_000) / 10_000
							: clampMs(metric.value),
					rating: metric.rating,
					navigation: metric.navigationType,
					route,
					device: currentDevice(),
				});
			};
			onCLS(report);
			onFCP(report);
			onINP(report);
			onLCP(report);
			onTTFB(report);
		})
		.catch(() => undefined);
}

type Pending = { start: number; tag?: string };
const pending = new Map<InteractionTiming, Pending>();
const markName = (name: InteractionTiming) => `ytimesy:${name}`;

/**
 * The interaction began now (a click, a send). A later start replaces an
 * unfinished one; `tag` names what it waits for (the sent message's id).
 */
export function startInteraction(name: InteractionTiming, tag?: string) {
	if (typeof performance === "undefined") return;
	pending.set(name, { start: performance.now(), tag });
	try {
		performance.mark(`${markName(name)}:start`);
	} catch {
		// Marks are a convenience for DevTools; the report does not need them.
	}
}

/** What the unfinished interaction waits for, if one is running. */
export function interactionTag(name: InteractionTiming) {
	return pending.get(name)?.tag;
}

export function interactionPending(name: InteractionTiming) {
	return pending.has(name);
}

/** The interaction will not finish (the view closed first): report nothing. */
export function cancelInteraction(name: InteractionTiming) {
	pending.delete(name);
}

/** The interaction's result is on screen: measure and report it once. */
export function finishInteraction(name: InteractionTiming) {
	const started = pending.get(name);
	if (!started || typeof window === "undefined") return;
	pending.delete(name);
	const end = performance.now();
	try {
		performance.measure(markName(name), { start: started.start, end });
	} catch {
		// See startInteraction.
	}
	const duration = end - started.start;
	if (duration > MAX_REPORTED_MS) return;
	captureAnalytics("interaction_timing", {
		interaction: name,
		duration_ms: clampMs(duration),
		route: analyticsRoute(window.location.pathname),
		device: currentDevice(),
	});
}
