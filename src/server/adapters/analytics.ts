import { createHash } from "node:crypto";
import type { PostHog } from "posthog-node";
import {
	type ServerAnalyticsEvent,
	type ServerAnalyticsProperties,
	serverAnalyticsEvents,
} from "#/domain/analytics";
import { scopedResource } from "./database-scope";
import { trackInvocationTask } from "./invocation-tasks";

let client: Promise<PostHog> | undefined;
const analyticsResource = Symbol("invocation-analytics");

/** Best-effort telemetry: never block coding or propagate ingestion failures. */
export function captureServerAnalytics<E extends ServerAnalyticsEvent>(
	userId: string,
	event: E,
	properties: ServerAnalyticsProperties<E>,
	identity: { key: string; timestamp: Date },
): Promise<void> {
	return trackInvocationTask(
		captureAnalytics(userId, event, properties, identity),
	);
}

async function captureAnalytics<E extends ServerAnalyticsEvent>(
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
