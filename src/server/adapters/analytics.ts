import { createHash } from "node:crypto";
import type { PostHog } from "posthog-node";
import {
	type ServerAnalyticsEvent,
	type ServerAnalyticsProperties,
	serverAnalyticsEvents,
} from "#/domain/analytics";

let client: Promise<PostHog> | undefined;

/** Best-effort telemetry: never block coding or propagate ingestion failures. */
export async function captureServerAnalytics<E extends ServerAnalyticsEvent>(
	userId: string,
	event: E,
	properties: ServerAnalyticsProperties<E>,
	identity: { key: string; timestamp: Date },
): Promise<void> {
	try {
		const token = process.env.POSTHOG_PROJECT_TOKEN;
		if (!token || !userId) return;
		const parsed = serverAnalyticsEvents[event].safeParse(properties);
		if (!parsed.success || !Number.isFinite(identity.timestamp.getTime()))
			return;
		client ??= import("posthog-node").then(
			({ PostHog }) =>
				new PostHog(token, {
					host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
					disableGeoip: true,
					flushInterval: 0,
					fetchRetryCount: 1,
					requestTimeout: 2_000,
				}),
		);
		const hex = createHash("sha256")
			.update(JSON.stringify([userId, event, identity.key]))
			.digest("hex");
		const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		await (await client).captureImmediate({
			distinctId: userId,
			event,
			uuid,
			timestamp: identity.timestamp,
			properties: {
				...parsed.data,
				$geoip_disable: true,
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
