import { productionToolsSnapshotId } from "./production-tools-image";

/**
 * The fixed runtime settings production always deploys with, kept apart from
 * scripts/deploy-production.ts (which has deployment side effects) so they
 * can be tested.
 */

/**
 * Retention only enrolls agent VMs created at or after this instant. Production
 * had no VMs before launch, so every production VM is enrolled.
 */
export const PRODUCTION_RETENTION_ENROLL_AFTER = "2026-10-01T00:00:00.000Z";

export function productionRuntimeSettings(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	return {
		// Set here, not in a wrangler vars block (that breaks the generated types).
		YTIMESY_ENVIRONMENT: "production",
		// Image and SDK ship as one approved pair, not a stale environment override.
		YTIMESY_TOOLS_SNAPSHOT_ID: productionToolsSnapshotId(),
		GIT_PROXY_ENABLED: "1",
		MODEL_EXECUTION_ENABLED: "1",
		ENVIRONMENT_EXECUTION_ENABLED: "1",
		BACKGROUND_EXECUTION_ENABLED: "1",
		YTIMESY_BACKGROUND_CRON_ENABLED: "1",
		YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
		// Production meters regardless (usage-admission.ts); kept explicit.
		YTIMESY_INFRASTRUCTURE_ADMISSION: "true",
		// Recycling stopped on 2026-11-11: idle VMs stay paused and Freestyle
		// deletes them after 90 days unused (docs/workspace-retention.md). This
		// stays on only so chats recycled before then restore from, and expire,
		// their snapshots. Turn it off once none is left in phase 'retained'.
		YTIMESY_WORKSPACE_RETENTION: "true",
		YTIMESY_RETENTION_ENROLL_AFTER:
			env.YTIMESY_RETENTION_ENROLL_AFTER || PRODUCTION_RETENTION_ENROLL_AFTER,
		// New chat, environment and job objects start near the production database
		// (Supabase us-east-2, Ohio); see src/server/edge/durable-object-location.ts.
		YTIMESY_DURABLE_OBJECT_LOCATION_HINT:
			env.YTIMESY_PRODUCTION_DURABLE_OBJECT_LOCATION_HINT || "enam",
		// Auth email goes out through the EMAIL send_email binding (wrangler config).
		AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM || "noreply@ytimesy.com",
		// Claude Code runs push their output to the chat object, which sleeps
		// between batches (src/domain/claude-feed.ts). "0" turns it off.
		YTIMESY_CLAUDE_FEED: env.YTIMESY_CLAUDE_FEED === "0" ? "0" : "1",
		// A Claude run on a runner box serves its workspace tools itself, with
		// a token for that one VM (docs/claude-code-placement.md). "0" turns it off.
		YTIMESY_CLAUDE_BOX_TOOLS: env.YTIMESY_CLAUDE_BOX_TOOLS === "0" ? "0" : "1",
	};
}

/**
 * Server analytics and exception capture read POSTHOG_PROJECT_TOKEN
 * (src/server/adapters/analytics.ts); the browser bundle reads
 * VITE_POSTHOG_PROJECT_TOKEN at build time. An older name, POSTHOG_KEY, was
 * deployed but never read, so production silently had no analytics.
 */
export function productionAnalyticsSettings(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
	if (env.POSTHOG_KEY && !env.POSTHOG_PROJECT_TOKEN)
		throw new Error(
			"POSTHOG_KEY is not read by the app; rename it to POSTHOG_PROJECT_TOKEN.",
		);
	const missing = [
		"POSTHOG_PROJECT_TOKEN",
		"VITE_POSTHOG_PROJECT_TOKEN",
	].filter((name) => !env[name]?.trim());
	if (missing.length)
		throw new Error(
			`Production deployment is missing ${missing.join(", ")} (PostHog project token; analytics and error capture).`,
		);
	return {
		POSTHOG_PROJECT_TOKEN: env.POSTHOG_PROJECT_TOKEN as string,
		POSTHOG_HOST: env.POSTHOG_HOST || "https://us.i.posthog.com",
		// Account deletion removes the PostHog person (person:write key);
		// without them it logs the person as a leftover.
		...Object.fromEntries(
			(["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"] as const)
				.filter((name) => env[name]?.trim())
				.map((name) => [name, env[name] as string]),
		),
	};
}

/** A production web build without the browser PostHog token ships blind. */
export function assertProductionBuildAnalytics(
	env: Readonly<Record<string, string | undefined>>,
) {
	if (env.CLOUDFLARE_ENV !== "production") return;
	if (!env.VITE_POSTHOG_PROJECT_TOKEN?.trim())
		throw new Error(
			"Production web build requires VITE_POSTHOG_PROJECT_TOKEN (browser analytics and error capture).",
		);
}

/**
 * Launch gate on a production wrangler config: workers_dev stays off and the
 * web Worker has no route until the owner says go live. The one exception is
 * the edge executor's own custom domain (docs/guest-hostname-design.md), which
 * VM guests use for the signed Git proxy: exactly one route, a custom domain
 * whose host is YTIMESY_GIT_PROXY_URL's, never the app's hostname.
 */
export function assertProductionRoutes(input: {
	readonly file: string;
	readonly text: string;
	readonly gitProxyUrl: string;
	readonly appUrl: string;
	/** YTIMESY_GO_LIVE=1: the owner's go-live for this deploy. */
	readonly goLive?: boolean;
}) {
	const production = input.text.slice(input.text.indexOf('"production"'));
	const refuse = (reason: string) =>
		new Error(`${input.file} production ${reason}`);
	if (!/"workers_dev":\s*false/.test(production))
		throw refuse("must keep workers_dev off.");
	if (/"route"\s*:/.test(production))
		throw refuse("must not set a route; only the executor custom domain.");
	const declared = production.match(/"routes"\s*:/g)?.length ?? 0;
	if (!declared) return;
	if (input.file !== "wrangler.edge-executor.jsonc") {
		// Go live: the web Worker may serve exactly the app host, and only when
		// the owner says so for this deploy (YTIMESY_GO_LIVE=1).
		if (!input.goLive) throw refuse("must have no routes until launch.");
		const block = production.match(/"routes"\s*:\s*(\[[^\]]*\])/)?.[1];
		let parsed: unknown = null;
		try {
			parsed = block ? JSON.parse(block) : null;
		} catch {}
		const appHost = new URL(input.appUrl).host;
		const only =
			Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
		if (
			declared !== 1 ||
			!only ||
			typeof only !== "object" ||
			Object.keys(only).sort().join(",") !== "custom_domain,pattern" ||
			(only as { custom_domain: unknown }).custom_domain !== true ||
			(only as { pattern: unknown }).pattern !== appHost
		)
			throw refuse(
				`may only route the app host ${appHost} (APP_URL): [{ "pattern": "${appHost}", "custom_domain": true }].`,
			);
		return;
	}
	const blocks = [...production.matchAll(/"routes"\s*:\s*(\[[^\]]*\])/g)];
	let routes: unknown;
	try {
		routes = declared === 1 && blocks.length === 1 && JSON.parse(blocks[0][1]);
	} catch {
		routes = null;
	}
	const host = new URL(input.gitProxyUrl).host;
	const route = Array.isArray(routes) && routes.length === 1 ? routes[0] : null;
	if (
		!route ||
		typeof route !== "object" ||
		Object.keys(route).sort().join(",") !== "custom_domain,pattern" ||
		(route as { custom_domain: unknown }).custom_domain !== true ||
		(route as { pattern: unknown }).pattern !== host ||
		host === new URL(input.appUrl).host
	)
		throw refuse(
			`may only route its custom domain ${host} (YTIMESY_GIT_PROXY_URL): [{ "pattern": "${host}", "custom_domain": true }].`,
		);
}
