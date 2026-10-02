import type { PostHog } from "posthog-js";
import {
	type AnalyticsEvent,
	type AnalyticsProperties,
	filteredAnalyticsProperties,
} from "#/domain/analytics";
import { replayPrivacy } from "./replay-privacy";

let client: Promise<PostHog | null> | undefined;
function analyticsClient(): Promise<PostHog | null> {
	if (typeof window === "undefined") return Promise.resolve(null);
	const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
	if (!token) return Promise.resolve(null);
	client ??= import("posthog-js")
		.then(({ default: posthog }) => {
			posthog.init(token, {
				api_host:
					import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
				autocapture: false,
				capture_pageview: false,
				capture_pageleave: false,
				capture_exceptions: false,
				disable_session_recording: false,
				session_recording: replayPrivacy,
				enable_recording_console_log: false,
				capture_performance: false,
				disable_surveys: true,
				disable_external_dependency_loading: false,
				advanced_disable_feature_flags: true,
				person_profiles: "identified_only",
				persistence: "localStorage",
				respect_dnt: true,
				before_send: (event) => {
					if (!event) return null;
					// Replay DOM is already masked by the recorder before this boundary.
					const properties =
						event.event === "$snapshot" &&
						Array.isArray(event.properties.$snapshot_data)
							? { $snapshot_data: event.properties.$snapshot_data }
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

/** Best-effort analytics must never block or fail a user operation. */
export function captureAnalytics<E extends AnalyticsEvent>(
	event: E,
	properties: AnalyticsProperties<E>,
) {
	void analyticsClient()
		.then((posthog) => posthog?.capture(event, properties))
		.catch(() => undefined);
}
export function setAnalyticsUser(userId: string | null) {
	void analyticsClient()
		.then((posthog) => {
			if (!posthog) return;
			if (userId) posthog.identify(userId);
			else posthog.reset();
		})
		.catch(() => undefined);
}
