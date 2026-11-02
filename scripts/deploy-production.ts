import { execFileSync } from "node:child_process";
import { createHmac, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	codexRelaySettingNames,
	codexRelaySettingsProblem,
} from "../src/domain/codex-egress";
import {
	assertProductionRoutes,
	productionAnalyticsSettings,
	productionRuntimeSettings,
} from "./production-settings";

/**
 * Production deploy for the edge executor and the web Worker. Not run yet:
 * production has never been deployed (docs/production-launch.md). It refuses
 * to run until every production-only input exists, so it cannot fall back to
 * development values or make the app public.
 *
 *   node --env-file=.secrets/production.env --import tsx scripts/deploy-production.ts --confirm-production
 *
 * .secrets/production.env holds production values only (fresh secrets, the
 * production GitHub App, the production database). Never pass the dev .env.
 * Secrets travel over stdin, never shell arguments or logs.
 */
const PRODUCTION_DATABASE_REF = "exampleprojectref";
const DEVELOPMENT_DATABASE_REF = "exampledevprojectref";

if (!process.argv.includes("--confirm-production"))
	throw new Error("Pass --confirm-production to deploy production.");

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
	// The production App's bot user id, credited as Co-authored-by on every
	// agent commit: `gh api users/<GITHUB_APP_SLUG>%5Bbot%5D --jq .id`.
	"GITHUB_APP_BOT_USER_ID",
	// Master key for stored project secrets and credentials. Escrow it before
	// any user data exists; there is no file fallback in production.
	"YTIMESY_SECRETS_KEY",
	// The executor's custom domain VM guests use for the signed Git proxy and
	// realtime (docs/guest-hostname-design.md), e.g. https://edge.ytimesy.com.
	"YTIMESY_GIT_PROXY_URL",
	// Verifies GitHub's signature on /api/github/repair-events deliveries; the
	// production GitHub App's webhook secret. Without it PR repair is off.
	"GITHUB_PR_REPAIR_WEBHOOK_SECRET",
	"YTIMESY_FLEET_MONTHLY_MICRO_USD",
	"YTIMESY_FLEET_LIFETIME_MICRO_USD",
	"R2_ACCOUNT_ID",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"R2_CHECKPOINT_BUCKET",
	// Cloudflare Turnstile on email sign-up, sign-in and password reset.
	"TURNSTILE_SITE_KEY",
	"TURNSTILE_SECRET_KEY",
] as const;
const secrets: Record<string, string> = {};
for (const name of required) {
	const value = process.env[name];
	if (!value) throw new Error(`Production deployment is missing ${name}.`);
	secrets[name] = value;
}

if (!/^\d+$/.test(secrets.GITHUB_APP_BOT_USER_ID))
	throw new Error(
		`GITHUB_APP_BOT_USER_ID must be the numeric id of ${secrets.GITHUB_APP_SLUG}[bot].`,
	);

// Per-user rolling usage windows (micro-USD of VM cost); the deployment's
// environment tunes them, these are the defaults.
secrets.YTIMESY_USER_5H_MICRO_USD =
	process.env.YTIMESY_USER_5H_MICRO_USD || "5000000";
secrets.YTIMESY_USER_WEEKLY_MICRO_USD =
	process.env.YTIMESY_USER_WEEKLY_MICRO_USD || "25000000";

const database = new URL(secrets.DATABASE_URL);
if (
	!database.username.includes(PRODUCTION_DATABASE_REF) ||
	secrets.DATABASE_URL.includes(DEVELOPMENT_DATABASE_REF)
)
	throw new Error("DATABASE_URL is not the production database.");
// The edge checks this itself (server config); without it every edge job fails.
if (database.searchParams.get("sslmode") !== "verify-full")
	throw new Error("DATABASE_URL needs sslmode=verify-full and sslrootcert.");
for (const name of ["APP_URL", "YTIMESY_GIT_PROXY_URL"] as const) {
	const url = new URL(secrets[name]);
	if (
		url.protocol !== "https:" ||
		/workers\.dev$|localhost|127\./.test(url.host)
	)
		throw new Error(`${name} must be a production HTTPS hostname.`);
}

// Launch gate: no public app route or workers.dev URL until the owner says go
// live; only the executor's own custom domain (the Git proxy host) is allowed.
for (const file of ["wrangler.web.jsonc", "wrangler.edge-executor.jsonc"])
	assertProductionRoutes({
		file,
		text: await readFile(file, "utf8"),
		gitProxyUrl: secrets.YTIMESY_GIT_PROXY_URL,
		appUrl: secrets.APP_URL,
		goLive: process.env.YTIMESY_GO_LIVE === "1",
	});

// Every migration must be applied to production before its code ships.
const migrations = execFileSync(
	"node",
	["--import", "tsx", "scripts/db-migrate.ts"],
	{
		encoding: "utf8",
		env: { ...process.env, MIGRATION_DATABASE_URL: secrets.DATABASE_URL },
	},
);
if (/not recorded/.test(migrations))
	throw new Error(
		`Apply pending production migrations first:\n${migrations.trim()}`,
	);

secrets.GITHUB_PRIVATE_KEY = createPrivateKey(
	secrets.GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n"),
)
	.export({ type: "pkcs8", format: "pem" })
	.toString();
const root = secrets.BETTER_AUTH_SECRET;
if (root.length < 32) throw new Error("Invalid application signing key.");
const derived = (purpose: string) =>
	createHmac("sha256", root).update(purpose).digest("hex");
secrets.MODEL_WORKFLOW_SECRET = derived(
	"ytimesy:model-workflows:production:v1",
);
secrets.GIT_PROXY_SECRET = derived("ytimesy:git-proxy:production:v1");
secrets.ENVIRONMENT_WORKFLOW_SECRET = derived(
	"ytimesy:environment-workflows:production:v1",
);
secrets.BACKGROUND_WORKFLOW_SECRET = derived(
	"ytimesy:background-workflows:production:v1",
);
secrets.PR_REPAIR_INGRESS_SECRET = derived(
	"ytimesy:pr-repair-ingress:production:v1",
);
secrets.YTIMESY_REALTIME_SECRET = derived("ytimesy:realtime:production:v1");
secrets.YTIMESY_GIT_PROXY_SECRET = secrets.GIT_PROXY_SECRET;
// Background delivery and recovery address the same chat objects as inference.
secrets.YTIMESY_REALTIME_URL = secrets.YTIMESY_GIT_PROXY_URL;
Object.assign(secrets, productionRuntimeSettings(process.env));
Object.assign(secrets, productionAnalyticsSettings(process.env));
for (const name of [
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"YTIMESY_TOOLS_SNAPSHOT_ID",
	"YTIMESY_CODEX_RELAY_URL",
	"YTIMESY_CODEX_RELAY_SECRET",
	// Further Codex egress relays, tried in order after the first (2..8).
	...codexRelaySettingNames,
	// The account whose login probes Codex egress paths every 5 minutes.
	"YTIMESY_CODEX_EGRESS_PROBE_USER_ID",
	// Owner alerts go to het@ytimesy.com unless this names another address.
	"YTIMESY_ALERT_EMAIL",
] as const) {
	if (process.env[name]) secrets[name] = process.env[name];
}
// Launch features: PR repair (comment @<slug> on a PR), Grok on a SuperGrok or
// X subscription, Claude Code on the user's Claude subscription. On unless the
// deployment's environment sets one to "0".
for (const name of [
	"YTIMESY_PR_REPAIR_ENABLED",
	"YTIMESY_XAI_SUBSCRIPTION_ENABLED",
	"YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED",
] as const)
	secrets[name] = process.env[name] === "0" ? "0" : "1";
const relayProblem = codexRelaySettingsProblem(secrets);
if (relayProblem) throw new Error(relayProblem);
const key = Buffer.from(
	secrets.YTIMESY_SECRETS_KEY,
	/^[a-f0-9]{64}$/i.test(secrets.YTIMESY_SECRETS_KEY) ? "hex" : "base64",
);
if (key.length !== 32) throw new Error("Production encryption key is invalid.");
const certPath = database.searchParams.get("sslrootcert");
if (certPath) secrets.DATABASE_SSL_CA = await readFile(certPath, "utf8");

/** Only calls without secret input may show wrangler's own error. */
function run(command: string, args: string[], input?: string, env?: object) {
	try {
		const output = execFileSync(command, args, {
			...(input ? { input } : {}),
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, ...env },
		});
		console.log(output);
	} catch (error) {
		const { stdout, stderr } = error as { stdout?: string; stderr?: string };
		let shown = `${stdout ?? ""}${stderr ?? ""}`;
		// Calls with secret input show wrangler's error with every value masked.
		if (input)
			for (const value of Object.values(secrets))
				if (value.length >= 4) shown = shown.split(value).join("[redacted]");
		console.error(shown);
		throw new Error(
			"Production deployment failed. Secret material was not logged.",
		);
	}
}
const wrangler = (config: string, args: string[], input?: string) =>
	run(
		"pnpm",
		["exec", "wrangler", ...args, "--config", config, "--env", "production"],
		input,
	);

// Edge executor first: the web Worker's EXECUTOR service binding targets it.
wrangler("wrangler.edge-executor.jsonc", ["deploy"]);
wrangler(
	"wrangler.edge-executor.jsonc",
	["secret", "bulk"],
	JSON.stringify(secrets),
);
run("pnpm", ["exec", "vite", "build"], undefined, {
	YTIMESY_TARGET: "cloudflare",
	CLOUDFLARE_ENV: "production",
});
// The web Worker ships the build output: vite's Cloudflare plugin writes
// dist/server/wrangler.json with the production env already applied, so it
// takes no --env (deploying wrangler.web.jsonc would bundle raw source).
const webBuild = (args: string[], input?: string) =>
	run(
		"pnpm",
		["exec", "wrangler", ...args, "--config", "dist/server/wrangler.json"],
		input,
	);
webBuild(["deploy"]);
// A name the build already sets as a plain variable (YTIMESY_ENVIRONMENT)
// cannot also be a secret: Cloudflare rejects the whole upload.
const webVars = new Set(
	Object.keys(
		(
			JSON.parse(await readFile("dist/server/wrangler.json", "utf8")) as {
				vars?: Record<string, unknown>;
			}
		).vars ?? {},
	),
);
// The web hands environment setup and background jobs to the edge over
// signed HTTPS, as the development server wires it (development-server.ts);
// unset, a new project's setup is never handed off and stays queued.
const webSecrets: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(secrets).filter(([name]) => !webVars.has(name)),
	),
	YTIMESY_ENVIRONMENT_WORKFLOW_URL: secrets.YTIMESY_GIT_PROXY_URL,
	YTIMESY_ENVIRONMENT_WORKFLOW_SECRET: secrets.ENVIRONMENT_WORKFLOW_SECRET,
	YTIMESY_BACKGROUND_WORKFLOW_URL: secrets.YTIMESY_GIT_PROXY_URL,
	YTIMESY_BACKGROUND_WORKFLOW_SECRET: secrets.BACKGROUND_WORKFLOW_SECRET,
	YTIMESY_PR_REPAIR_INGRESS_SECRET: secrets.PR_REPAIR_INGRESS_SECRET,
};
webBuild(["secret", "bulk"], JSON.stringify(webSecrets));
console.log(
	process.env.YTIMESY_GO_LIVE === "1"
		? `Production deployed and live at ${secrets.APP_URL}.`
		: "Production deployed with no public app route.",
);
