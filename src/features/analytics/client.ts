import type { PostHog } from "posthog-js";
import {
	ANALYTICS_PROXY_PATH,
	type AnalyticsEvent,
	type AnalyticsProperties,
	filteredAnalyticsProperties,
} from "#/domain/analytics";
import { redactDeep, replaySafeUrl } from "#/domain/redact-secrets";
import type { ConsentTier } from "./consent-tier";
import {
	type ReplayChoice,
	readReplayChoice,
	replayBrowserBlock,
	replayRecords,
	writeReplayChoice,
} from "./replay-choice";
import { replayPrivacy, replaySnapshotData } from "./replay-privacy";

let client: Promise<PostHog | null> | undefined;
let tier: ConsentTier = "notice";

/** Set from the server-known region before the client starts (Analytics). */
export function setConsentTier(next: ConsentTier) {
	tier = next;
}

/**
 * Whether analytics may run at all. A Do Not Track or Global Privacy Control
 * signal stops it everywhere; where analytics waits for consent (tier
 * "analytics") nothing starts, sends or is stored until the visitor accepts.
 */
function analyticsAllowed() {
	if (replayBrowserBlock() !== null) return false;
	return tier !== "analytics" || readReplayChoice() === "allowed";
}

function analyticsClient(): Promise<PostHog | null> {
	if (typeof window === "undefined") return Promise.resolve(null);
	if (!analyticsAllowed()) return Promise.resolve(null);
	const token = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
	if (!token) return Promise.resolve(null);
	client ??= import("posthog-js")
		.then(({ default: posthog }) => {
			posthog.init(token, {
				// Our own origin (src/server/web/analytics-proxy.ts), which blockers
				// can't tell apart from the app; PostHog's links still go to its app.
				api_host: ANALYTICS_PROXY_PATH,
				ui_host: "https://us.posthog.com",
				autocapture: false,
				// $pageview on load and route changes, for PostHog's Web analytics;
				// before_send keeps only origin, path and referring domain.
				capture_pageview: "history_change",
				// Time on page and bounce rate for PostHog's Web analytics.
				capture_pageleave: true,
				// Uncaught errors and unhandled rejections, as $exception events.
				capture_exceptions: {
					capture_unhandled_errors: true,
					capture_unhandled_rejections: true,
					capture_console_errors: false,
				},
				// Replay starts when the region's consent rule allows it
				// (consent-tier.ts), masked by replayPrivacy.
				disable_session_recording: true,
				session_recording: replayPrivacy,
				enable_recording_console_log: false,
				// $web_vitals for PostHog's Web vitals page (values only, see
				// filteredAnalyticsProperties); no network timing.
				capture_performance: { web_vitals: true, network_timing: false },
				disable_surveys: true,
				disable_external_dependency_loading: false,
				advanced_disable_feature_flags: true,
				person_profiles: "identified_only",
				persistence: "localStorage",
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
						// SDK metadata, no user data: PostHog's health checks read the
						// browser SDK version and whether events came through our proxy.
						$lib: event.properties.$lib,
						$lib_version: event.properties.$lib_version,
						$lib_custom_api_host: event.properties.$lib_custom_api_host,
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

/**
 * Whether this page may record (setAnalyticsUser): anyone signed out, and a
 * signed-in user who has accepted the current Privacy Policy. The region's
 * consent rule applies on top (applyReplay).
 */
let replayAllowed = false;

/**
 * Masked session replay (replayPrivacy) runs when the page allows it, no
 * browser signal (Do Not Track, Global Privacy Control) blocks it and the
 * visitor has not turned it off in Cookie settings; otherwise it stops.
 */
async function applyReplay(posthog: PostHog) {
	// The SDK's own events (page views, errors, web vitals) don't pass
	// analyticsClient, so withdrawing consent also opts the SDK out.
	if (!analyticsAllowed()) posthog.opt_out_capturing();
	else if (tier === "analytics")
		posthog.opt_in_capturing({ captureEventName: false });
	const record = replayRecords({
		allowed: replayAllowed,
		block: replayBrowserBlock(),
		choice: readReplayChoice(),
		consentRequired: tier !== "notice",
	});
	if (record) {
		// Our own copy of the recorder, fetched only now: the SDK's would load
		// from /static/<v>/posthog-recorder.js, a file name blockers list.
		await import("./replay-recorder");
		if (!posthog.sessionRecordingStarted()) posthog.startSessionRecording();
	} else if (posthog.sessionRecordingStarted()) posthog.stopSessionRecording();
}

/**
 * Cookie settings and the consent banner: a choice takes effect at once.
 * Off stops replay (and, where analytics waits for consent, all of it);
 * on starts what the region allows.
 */
export function setReplayChoice(choice: ReplayChoice) {
	writeReplayChoice(choice);
	// A client that already exists must hear a withdrawal, so it is read
	// directly: analyticsClient() returns nothing once consent is gone.
	void (analyticsAllowed() ? analyticsClient() : client)
		?.then((posthog) => (posthog ? applyReplay(posthog) : undefined))
		.catch(() => undefined);
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
			// Only a sign-out clears the identity. Resetting a visitor who was
			// never identified gave them a new ID on every page load, and split
			// one page's events across two IDs.
			else if (posthog.get_property("$user_state") === "identified")
				posthog.reset();
			replayAllowed = options.replay;
			return applyReplay(posthog);
		})
		.catch(() => undefined);
}
