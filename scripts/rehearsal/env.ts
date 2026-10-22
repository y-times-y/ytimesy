// The process environment of the in-process edge: what
// scripts/deploy-edge-development.ts sets on the development edge, with
// every external endpoint and credential left out. Applied before any
// server module is loaded. Refuses to run with a hosted database or a
// provider key in the environment, so a rehearsal can never reach them.
import { randomBytes } from "node:crypto";

const FORBIDDEN = [
	"FREESTYLE_API_KEY",
	"YTIMESY_CODEX_RELAY_URL",
	"YTIMESY_CODEX_RELAY_SECRET",
	"YTIMESY_BACKGROUND_WORKFLOW_URL",
	"YTIMESY_ENVIRONMENT_WORKFLOW_URL",
	"YTIMESY_GIT_PROXY_URL",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENROUTER_API_KEY",
	"SUPABASE_STORAGE_URL",
	"SUPABASE_STORAGE_SERVICE_KEY",
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"POSTHOG_PROJECT_TOKEN",
	"YTIMESY_INFRASTRUCTURE_ADMISSION",
];

export function applyRehearsalEnvironment(databaseUrl: string) {
	const url = new URL(databaseUrl);
	if (url.hostname !== "127.0.0.1")
		throw new Error("The rehearsal only runs against a local database.");
	for (const name of FORBIDDEN) delete process.env[name];
	Object.assign(process.env, {
		DATABASE_URL: databaseUrl,
		// The edge connects through Hyperdrive; its URL check is skipped.
		YTIMESY_DATABASE_VIA_HYPERDRIVE: "1",
		DATABASE_POOL_MAX: "8",
		APP_URL: "http://127.0.0.1:3999",
		BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
		GITHUB_OAUTH_CLIENT_ID: "rehearsal",
		GITHUB_OAUTH_CLIENT_SECRET: "rehearsal",
		GITHUB_APP_CLIENT_ID: "rehearsal",
		GITHUB_APP_CLIENT_SECRET: "rehearsal",
		GITHUB_APP_SLUG: "rehearsal",
		YTIMESY_SECRETS_KEY: randomBytes(32).toString("hex"),
		MODEL_WORKFLOW_SECRET: randomBytes(32).toString("hex"),
		MODEL_EXECUTION_ENABLED: "1",
		BACKGROUND_EXECUTION_ENABLED: "1",
		YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
		YTIMESY_ENVIRONMENT: "development",
		YTIMESY_DEV_EVAL_USERS: "1",
		// Turn coordination and snapshots go to the in-process room.
		YTIMESY_REALTIME_URL: "https://rehearsal.invalid",
		YTIMESY_REALTIME_SECRET: randomBytes(32).toString("hex"),
		YTIMESY_ENVIRONMENT_AUTO_REFRESH: "false",
		// As the development edge was run for these runs: failures carry their cause.
		YTIMESY_DEBUG_TURN_ERRORS: "1",
		// Reached only through the in-process executor binding (edge.web);
		// the .invalid name never resolves, so nothing leaves the machine.
		YTIMESY_BACKGROUND_WORKFLOW_URL: "https://rehearsal-edge.invalid/",
		YTIMESY_BACKGROUND_WORKFLOW_SECRET: randomBytes(32).toString("hex"),
	});
}
