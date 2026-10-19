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
		GIT_PROXY_ENABLED: "1",
		MODEL_EXECUTION_ENABLED: "1",
		ENVIRONMENT_EXECUTION_ENABLED: "1",
		BACKGROUND_EXECUTION_ENABLED: "1",
		YTIMESY_BACKGROUND_CRON_ENABLED: "1",
		YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
		// Production meters regardless (usage-admission.ts); kept explicit.
		YTIMESY_INFRASTRUCTURE_ADMISSION: "true",
		// Idle agent VMs are snapshotted (verified on an independent copy), then
		// deleted; their snapshots expire after 90 days. Without this, paused VMs
		// and snapshots accumulate forever on the provider plan.
		YTIMESY_WORKSPACE_RETENTION: "true",
		YTIMESY_RETENTION_ENROLL_AFTER:
			env.YTIMESY_RETENTION_ENROLL_AFTER || PRODUCTION_RETENTION_ENROLL_AFTER,
		// New chat, environment and job objects start near the production database
		// (Supabase us-east-2, Ohio); see src/server/edge/durable-object-location.ts.
		YTIMESY_DURABLE_OBJECT_LOCATION_HINT:
			env.YTIMESY_PRODUCTION_DURABLE_OBJECT_LOCATION_HINT || "enam",
		// Auth email goes out through the EMAIL send_email binding (wrangler config).
		AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM || "noreply@ytimesy.com",
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
