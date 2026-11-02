import { createHash } from "node:crypto";
import type { PostHog } from "posthog-node";
import {
	type ServerAnalyticsEvent,
	type ServerAnalyticsProperties,
	serverAnalyticsEvents,
} from "#/domain/analytics";
import { redactSecrets } from "#/domain/redact-secrets";
import { scopedResource } from "./database-scope";
import { trackInvocationTask } from "./invocation-tasks";

let client: Promise<PostHog> | undefined;

type AnalyticsIdentity = {
	key: string;
	timestamp: Date;
	/** Person properties PostHog keeps from the first time they are set. */
	setOnce?: Record<string, string>;
};
const analyticsResource = Symbol("invocation-analytics");

/** Best-effort telemetry: never block coding or propagate ingestion failures. */
export function captureServerAnalytics<E extends ServerAnalyticsEvent>(
	userId: string,
	event: E,
	properties: ServerAnalyticsProperties<E>,
	identity: AnalyticsIdentity,
): Promise<void> {
	return trackInvocationTask(
		captureAnalytics(userId, event, properties, identity),
	);
}

async function captureAnalytics<E extends ServerAnalyticsEvent>(
	userId: string,
	event: E,
	properties: ServerAnalyticsProperties<E>,
	identity: AnalyticsIdentity,
): Promise<void> {
	try {
		const token = process.env.POSTHOG_PROJECT_TOKEN;
		if (!token || !userId) return;
		const parsed = serverAnalyticsEvents[event].safeParse(properties);
		if (!parsed.success || !Number.isFinite(identity.timestamp.getTime()))
			return;
		const active = posthogClient(token);
		const hex = createHash("sha256")
			.update(JSON.stringify([userId, event, identity.key]))
			.digest("hex");
		const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		await (await active).captureImmediate({
			distinctId: userId,
			event,
			uuid,
			timestamp: identity.timestamp,
			properties: {
				...parsed.data,
				$geoip_disable: true,
				...(identity.setOnce && Object.keys(identity.setOnce).length > 0
					? { $set_once: identity.setOnce }
					: {}),
				environment:
					process.env.NODE_ENV === "test"
						? "verification"
						: process.env.NODE_ENV === "production"
							? "production"
							: "development",
			},
		});
	} catch {
		// Analytics outages must not fail a saved operation.
	}
}

/** One PostHog client per invocation scope (Workers), else per process. */
function posthogClient(token: string): Promise<PostHog> {
	const create = () =>
		import("posthog-node").then(
			({ PostHog }) =>
				new PostHog(token, {
					host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
					disableGeoip: true,
					flushInterval: 0,
					fetchRetryCount: 1,
					requestTimeout: 2_000,
				}),
		);
	let active = scopedResource(analyticsResource, create, async (posthog) => {
		await posthog.shutdown();
	});
	if (!active) {
		client ??= create();
		active = client;
	}
	return active;
}

/** Error text with tokens, credentials in URLs and long opaque strings removed. */
export const redactErrorText = (text: string) => redactSecrets(text);

/**
 * Best-effort server error tracking (PostHog exceptions): the error's class,
 * redacted message and stack, and where it happened. Never throws.
 */
export function captureServerException(
	error: unknown,
	context: {
		source: string;
		userId?: string;
		properties?: Record<string, string | number | boolean | null>;
	},
): Promise<void> {
	return trackInvocationTask(
		(async () => {
			try {
				const token = process.env.POSTHOG_PROJECT_TOKEN;
				if (!token) return;
				const original =
					error instanceof Error ? error : new Error(String(error));
				const safe = new Error(redactErrorText(original.message));
				safe.name = original.name;
				safe.stack = original.stack
					? redactErrorText(original.stack)
					: undefined;
				await (await posthogClient(token)).captureExceptionImmediate(
					safe,
					context.userId || `server:${context.source}`,
					{
						...context.properties,
						source: context.source,
						$geoip_disable: true,
						environment: process.env.YTIMESY_ENVIRONMENT ?? "unknown",
					},
				);
			} catch {
				// Error tracking outages must not add a second failure.
			}
		})(),
	);
}
