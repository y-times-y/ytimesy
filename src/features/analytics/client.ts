import type { PostHog } from "posthog-js";
import {
	type AnalyticsEvent,
	type AnalyticsProperties,
	filteredAnalyticsProperties,
} from "#/domain/analytics";
import { redactDeep, replaySafeUrl } from "#/domain/redact-secrets";
import { replayPrivacy, replaySnapshotData } from "./replay-privacy";

/** Where analytics events go; the page preconnects to it (src/routes/__root.tsx). */
export const ANALYTICS_HOST =
	import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
export const ANALYTICS_ENABLED = Boolean(
	import.meta.env.VITE_POSTHOG_PROJECT_TOKEN,
);

let client: Promise<PostHog | null> | undefined;
// EU/EEA/UK/Swiss visitors: nothing is stored in the browser (no consent
// banner needed); the identifier lives in memory for the page's life.
let storeNothing = false;

/** Set from the server-known region before the client starts (Analytics). */
export function setAnalyticsStrictRegion(strict: boolean) {
	if (!client) storeNothing = strict;
}

export function analyticsPersistence(strict: boolean) {
	return strict ? ("memory" as const) : ("localStorage" as const);
}
function analyticsClient(): Promise<PostHog | null> {
	if (typeof window === "undefined") return Promise.resolve(null);
	const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
	if (!token) return Promise.resolve(null);
	client ??= import("posthog-js")
		.then(({ default: posthog }) => {
			posthog.init(token, {
				api_host: ANALYTICS_HOST,
				autocapture: false,
				capture_pageview: false,
				capture_pageleave: false,
				// Uncaught errors and unhandled rejections, as $exception events.
				capture_exceptions: {
					capture_unhandled_errors: true,
					capture_unhandled_rejections: true,
					capture_console_errors: false,
				},
				// Replay starts only for a signed-in user outside the EU/UK
				// (setAnalyticsUser), masked by replayPrivacy.
				disable_session_recording: true,
				session_recording: replayPrivacy,
				enable_recording_console_log: false,
				capture_performance: false,
				disable_surveys: true,
				disable_external_dependency_loading: false,
				advanced_disable_feature_flags: true,
				person_profiles: "identified_only",
				persistence: analyticsPersistence(storeNothing),
				respect_dnt: true,
				before_send: (event) => {
					if (!event) return null;
					// Replay DOM is already masked by the recorder before this boundary.
					if (
						event.event === "$snapshot" &&
						typeof window.location?.href === "string" &&
						replaySafeUrl(window.location.href) === null
					)
						return null;
					const properties =
						event.event === "$snapshot" &&
						Array.isArray(event.properties.$snapshot_data)
							? {
									$snapshot_data: replaySnapshotData(
										event.properties.$snapshot_data,
									),
								}
							: event.event === "$exception"
								? exceptionProperties(event.properties)
								: filteredAnalyticsProperties(event.event, event.properties);
					if (!properties) return null;
					event.properties = {
						...properties,
						token,
						distinct_id: event.properties.distinct_id,
						$process_person_profile: event.properties.$process_person_profile,
						$geoip_disable: true,
						$session_id: event.properties.$session_id,
						$window_id: event.properties.$window_id,
						environment: import.meta.env.PROD ? "production" : "development",
					};
					delete event.$set;
					delete event.$set_once;
					return event;
				},
			});
			return posthog;
		})
		.catch(() => null);
	return client;
}

/** Do Not Track turns off everything the browser would send, replay included. */
function doNotTrack() {
	return typeof navigator !== "undefined" && navigator.doNotTrack === "1";
}

/** Set by the old recording prompt (removed); a "Decline" given there still holds. */
export const DECLINED_REPLAY_KEY = "ytimesy.replay-consent";
function replayDeclined() {
	try {
		return globalThis.localStorage?.getItem(DECLINED_REPLAY_KEY) === "declined";
	} catch {
		return false;
	}
}

/**
 * Masked session replay runs for signed-in users, except in the EU/UK
 * (privacy-region.ts), under Do Not Track, or after an earlier decline;
 * signing out stops it.
 */
function applyReplay(posthog: PostHog, record: boolean) {
	if (record && !doNotTrack() && !replayDeclined()) {
		if (!posthog.sessionRecordingStarted()) posthog.startSessionRecording();
	} else if (posthog.sessionRecordingStarted()) posthog.stopSessionRecording();
}

/** Error tracking keeps the exception itself and the page path, nothing else. */
function exceptionProperties(properties: Record<string, unknown>) {
	const path =
		typeof window === "undefined" ? undefined : window.location.pathname;
	return {
		$exception_list: redactDeep(properties.$exception_list),
		$exception_level: properties.$exception_level,
		$exception_fingerprint: properties.$exception_fingerprint,
		...(path ? { path: path.slice(0, 200) } : {}),
	};
}

/** Best-effort analytics must never block or fail a user operation. */
export function captureAnalytics<E extends AnalyticsEvent>(
	event: E,
	properties: AnalyticsProperties<E>,
) {
	void analyticsClient()
		.then((posthog) => posthog?.capture(event, properties))
		.catch(() => undefined);
}
export function setAnalyticsUser(
	userId: string | null,
	options: { readonly replay: boolean },
) {
	void analyticsClient()
		.then((posthog) => {
			if (!posthog) return;
			if (userId) posthog.identify(userId);
			else posthog.reset();
			applyReplay(posthog, Boolean(userId) && options.replay);
		})
		.catch(() => undefined);
}
