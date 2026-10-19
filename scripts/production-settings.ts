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
