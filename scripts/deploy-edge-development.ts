import { execFileSync } from "node:child_process";
import { createHmac, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";

// Deliberately fixed to development. Secrets travel over stdin, never shell arguments or logs.
const configuration = "wrangler.edge-executor.jsonc";
const required = [
	"DATABASE_URL",
	"APP_URL",
	"BETTER_AUTH_SECRET",
	"FREESTYLE_API_KEY",
	"GITHUB_APP_ID",
	"GITHUB_PRIVATE_KEY",
	"GITHUB_APP_CLIENT_ID",
	"GITHUB_APP_CLIENT_SECRET",
	"GITHUB_OAUTH_CLIENT_ID",
	"GITHUB_OAUTH_CLIENT_SECRET",
	"GITHUB_APP_SLUG",
] as const;
const secrets: Record<string, string> = {};
for (const name of required) {
	const value = process.env[name];
	if (!value) throw new Error(`Development deployment is missing ${name}.`);
	secrets[name] = value;
}
// Octokit's Web Crypto adapter accepts PKCS#8; preserve the existing RSA key identity.
secrets.GITHUB_PRIVATE_KEY = createPrivateKey(
	secrets.GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
)
	.export({ type: "pkcs8", format: "pem" })
	.toString();
const root = secrets.BETTER_AUTH_SECRET;
if (root.length < 32) throw new Error("Invalid application signing key.");
const derived = (purpose: string) =>
	createHmac("sha256", root).update(purpose).digest("hex");
secrets.MODEL_WORKFLOW_SECRET =
	process.env.YTIMESY_MODEL_WORKFLOW_SECRET ||
	derived("ytimesy:model-workflows:development:v1");
secrets.GIT_PROXY_SECRET =
	process.env.YTIMESY_GIT_PROXY_SECRET ||
	derived("ytimesy:git-proxy:development:v1");
secrets.ENVIRONMENT_WORKFLOW_SECRET =
	process.env.YTIMESY_ENVIRONMENT_WORKFLOW_SECRET ||
	derived("ytimesy:environment-workflows:development:v1");
secrets.GIT_PROXY_ENABLED = "1";
secrets.MODEL_EXECUTION_ENABLED = "1";
secrets.ENVIRONMENT_EXECUTION_ENABLED = "1";
secrets.BACKGROUND_EXECUTION_ENABLED = "1";
secrets.YTIMESY_BACKGROUND_CRON_ENABLED = "1";
secrets.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
// Turns, builds and jobs start VMs here; without admission their runtime caps
// are never extended and usage isn't held against the allowance.
secrets.YTIMESY_INFRASTRUCTURE_ADMISSION = "true";
// Development only: throwaway eval users (dev_eval_user) borrow their owner's
// Codex login and carry per-run harness variants. Production never sets it.
secrets.YTIMESY_DEV_EVAL_USERS = "1";
for (const name of [
	"YTIMESY_USER_MONTHLY_MICRO_USD",
	"YTIMESY_FLEET_MONTHLY_MICRO_USD",
	"YTIMESY_FLEET_LIFETIME_MICRO_USD",
] as const) {
	const value = process.env[name];
	if (!value) throw new Error(`Development deployment is missing ${name}.`);
	secrets[name] = value;
}
secrets.BACKGROUND_WORKFLOW_SECRET =
	process.env.YTIMESY_BACKGROUND_WORKFLOW_SECRET ||
	derived("ytimesy:background-workflows:development:v1");
for (const name of [
	"SUPABASE_STORAGE_URL",
	"SUPABASE_STORAGE_SERVICE_KEY",
	// Cloudflare R2 replaces Supabase Storage for checkpoints when set.
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_CHECKPOINT_BUCKET",
	"YTIMESY_REALTIME_URL",
	"YTIMESY_REALTIME_SECRET",
	"YTIMESY_TOOLS_SNAPSHOT_ID",
	"YTIMESY_CODEX_RELAY_URL",
	"YTIMESY_CODEX_RELAY_SECRET",
	"YTIMESY_PR_REPAIR_ENABLED",
	// Cloudflare Email Service sender for verification and password-reset mail.
	"AUTH_EMAIL_FROM",
	"CLOUDFLARE_EMAIL_ACCOUNT_ID",
	"CLOUDFLARE_EMAIL_API_TOKEN",
	// Development only: force a provider outage to exercise model failover.
	"YTIMESY_DEV_FORCE_MODEL_OUTAGE",
	// Development only: offer every connected model (e.g. free test models).
	"YTIMESY_DEV_ALLOW_ANY_MODEL",
	// Development only: log per-step phase timings (src/server/services/step-timing.ts).
	"YTIMESY_DEBUG_STEP_TIMING",
] as const) {
	if (process.env[name]) secrets[name] = process.env[name];
}
// ytimesy.com is onboarded to Email Sending; the EMAIL binding sends from here.
secrets.AUTH_EMAIL_FROM ||= "noreply@ytimesy.com";
if (
	Boolean(secrets.YTIMESY_CODEX_RELAY_URL) !==
	Boolean(secrets.YTIMESY_CODEX_RELAY_SECRET)
)
	throw new Error(
		"Subscription relay URL and signing key must be configured together.",
	);
if (
	secrets.YTIMESY_CODEX_RELAY_SECRET &&
	secrets.YTIMESY_CODEX_RELAY_SECRET.length < 32
)
	throw new Error("Subscription relay signing key is invalid.");
if (!secrets.YTIMESY_REALTIME_URL || !secrets.YTIMESY_REALTIME_SECRET) {
	const realtime = JSON.parse(
		await readFile(".ytimesy/realtime-development.json", "utf8"),
	) as { url?: string; secret?: string };
	if (!realtime.url || !realtime.secret)
		throw new Error("Development realtime configuration is unavailable.");
	secrets.YTIMESY_REALTIME_URL = realtime.url;
	secrets.YTIMESY_REALTIME_SECRET = realtime.secret;
}
secrets.YTIMESY_GIT_PROXY_SECRET = secrets.GIT_PROXY_SECRET;
secrets.YTIMESY_GIT_PROXY_URL =
	"https://ytimesy-edge-executor-development.hetkp8044.workers.dev";
// Background delivery and recovery must address the same chat objects as inference.
secrets.YTIMESY_REALTIME_URL = secrets.YTIMESY_GIT_PROXY_URL;
// Load the original key; never call a helper that could generate a replacement.
secrets.YTIMESY_SECRETS_KEY =
	process.env.YTIMESY_SECRETS_KEY ||
	(await readFile(".ytimesy/secrets.key", "utf8")).trim();
const key = Buffer.from(
	secrets.YTIMESY_SECRETS_KEY,
	/^[a-f0-9]{64}$/i.test(secrets.YTIMESY_SECRETS_KEY) ? "hex" : "base64",
);
if (key.length !== 32)
	throw new Error("Original project encryption key is invalid.");
const certPath = new URL(secrets.DATABASE_URL).searchParams.get("sslrootcert");
if (certPath) secrets.DATABASE_SSL_CA = await readFile(certPath, "utf8");

/** Only calls without secret input may show wrangler's own error. */
function wrangler(args: string[], input?: string) {
	try {
		const output = execFileSync(
			"pnpm",
			["exec", "wrangler", ...args, "--config", configuration],
			{
				...(input ? { input } : {}),
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				maxBuffer: 1024 * 1024,
			},
		);
		console.log(output);
	} catch (error) {
		if (!input) {
			const { stdout, stderr } = error as { stdout?: string; stderr?: string };
			console.error(`${stdout ?? ""}${stderr ?? ""}`);
		}
		throw new Error(
			"Development edge deployment failed. Secret material was not logged.",
		);
	}
}
wrangler(["deploy"]);
wrangler(["secret", "bulk"], JSON.stringify(secrets));
console.log(
	"Development edge enabled: model turns, environments, background jobs and Git proxy.",
);
