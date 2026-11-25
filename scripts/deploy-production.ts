import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, createPrivateKey } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	codexRelaySettingNames,
	codexRelaySettingsProblem,
} from "../src/domain/codex-egress";
import {
	deriveTestSessionToken,
	hashTestSessionToken,
} from "../src/domain/test-account";
import { acquireDeployLock } from "./deploy-lock";
import {
	IN_FLIGHT_WORK_NOTE,
	productionDeploySteps,
	rollbackStep,
	type ServingVersions,
	servingVersions,
} from "./production-deploy-steps";
import {
	missingDeployedSettings,
	productionPreflightProblems,
	requiredSettingNames,
	secretListFailure,
} from "./production-preflight";
import {
	assertProductionRoutes,
	productionAnalyticsSettings,
	productionRuntimeSettings,
} from "./production-settings";
import {
	productionBuildId,
	productionSmokeChecks,
	runSmokeChecks,
} from "./production-smoke-check";
import {
	ALLOW_UNVERIFIED_SOURCE_VARIABLE,
	deploySourceProblem,
} from "./production-source";
import { readRunningTurns, runningTurnsDecision } from "./running-turns-check";
import { supabaseCertificate } from "./supabase-certificate";
import { liveWorkerBindingProblems } from "./worker-bindings-guard";

/**
 * Production deploy for the edge executor and the web Worker. It refuses to
 * run until every production-only input exists, so it cannot fall back to
 * development values or make the app public, and its preflight
 * (production-preflight.ts) checks every setting both Workers read before
 * anything ships.
 *
 *   node --env-file=.secrets/production.env --import tsx scripts/deploy-production.ts --confirm-production
 *
 * --preflight-only builds the web and runs the preflight, then stops: it
 * deploys nothing and skips the migration check (no database access).
 *
 * It also refuses unless the checkout is exactly origin/main with no changed
 * tracked files (production-source.ts); --allow-unverified-source overrides.
 *
 * A deploy reports the chats running a turn and goes ahead at once. It never
 * waits for them: turns are always running. API turns resume from their
 * checkpoint on the new version; a Claude turn caught by the Durable Object
 * reset may need a retry.
 *
 * .secrets/production.env holds production values only (fresh secrets, the
 * production GitHub App, the production database). Never pass the dev .env.
 * Secrets travel over stdin, never shell arguments or logs.
 */
const PRODUCTION_DATABASE_REF = "exampleprojectref";
const DEVELOPMENT_DATABASE_REF = "exampledevprojectref";

const preflightOnly = process.argv.includes("--preflight-only");
if (!preflightOnly && !process.argv.includes("--confirm-production"))
	throw new Error("Pass --confirm-production to deploy production.");

// Build only from origin/main: a stale or detached checkout once shipped old code.
const allowUnverifiedSource = process.argv.includes(
	"--allow-unverified-source",
);
if (
	!preflightOnly &&
	!allowUnverifiedSource &&
	!process.env.YTIMESY_OVERLAY_APPLIED
) {
	const read = (...args: string[]) =>
		execFileSync("git", args, { encoding: "utf8" });
	execFileSync("git", ["fetch", "--quiet", "origin", "main"]);
	const sourceProblem = deploySourceProblem({
		head: read("rev-parse", "HEAD"),
		originMain: read("rev-parse", "origin/main"),
		trackedChanges: read("status", "--porcelain", "--untracked-files=no"),
	});
	if (sourceProblem) throw new Error(sourceProblem);
}

// The public repository carries placeholders where the owner's real account,
// database and project identifiers are. A private patch (never committed;
// default ~/.ytimesy-private/production-overlay.patch, or the path in
// YTIMESY_PRODUCTION_OVERLAY) puts them back for this deploy only. It is
// applied after the source checks above, then this script runs again from the
// patched files (its constants are read at load) and the patch is reversed
// when that run ends.
const overlay =
	process.env.YTIMESY_PRODUCTION_OVERLAY ||
	join(process.env.HOME ?? "", ".ytimesy-private", "production-overlay.patch");
if (!process.env.YTIMESY_OVERLAY_APPLIED && existsSync(overlay)) {
	execFileSync("git", ["apply", overlay]);
	console.log("Applied the private production overlay for this deploy.");
	let status = 1;
	try {
		status =
			spawnSync(
				process.execPath,
				[...process.execArgv, ...process.argv.slice(1)],
				{
					stdio: "inherit",
					env: { ...process.env, YTIMESY_OVERLAY_APPLIED: "1" },
				},
			).status ?? 1;
	} finally {
		try {
			execFileSync("git", ["apply", "-R", overlay]);
		} catch {
			console.error(
				`Could not reverse the private overlay; run: git apply -R ${overlay}`,
			);
		}
	}
	process.exit(status);
}

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
if (!preflightOnly) {
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
}

// Report the running turns and go ahead at once: a deploy never waits for a
// chat. Turns are always running; each Worker takes one new version, Durable
// Objects move to it once idle, and an interrupted step resumes from its
// checkpoint. Only an unreadable count stops the deploy (a database fault).
if (!preflightOnly) {
	const decision = runningTurnsDecision(
		await readRunningTurns(secrets.DATABASE_URL),
	);
	console.log(decision.message);
	if (!decision.proceed) throw new Error(decision.message);
}

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
// The synthetic test account's capability (docs/testing-live.md): the Worker
// keeps only the hash. Set YTIMESY_TEST_SESSION_TOKEN_VERSION to a new value
// to revoke every copy of the token.
secrets.YTIMESY_TEST_SESSION_TOKEN_SHA256 = hashTestSessionToken(
	deriveTestSessionToken(
		root,
		process.env.YTIMESY_TEST_SESSION_TOKEN_VERSION || "1",
	),
);
secrets.YTIMESY_GIT_PROXY_SECRET = secrets.GIT_PROXY_SECRET;
// Background delivery and recovery address the same chat objects as inference.
secrets.YTIMESY_REALTIME_URL = secrets.YTIMESY_GIT_PROXY_URL;
Object.assign(secrets, productionRuntimeSettings(process.env));
Object.assign(secrets, productionAnalyticsSettings(process.env));
for (const name of [
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"YTIMESY_CODEX_TUNNEL_URL",
	// Legacy HMAC key for the Codex proxy; superseded by the signing key below.
	"YTIMESY_CODEX_TUNNEL_SECRET",
	// The Workers' Ed25519 key for Codex proxy credentials
	// (scripts/generate-codex-tunnel-keypair.ts); the proxy holds its public key.
	// When set, the Workers send only Ed25519 credentials.
	"YTIMESY_CODEX_TUNNEL_SIGNING_KEY",
	"YTIMESY_CODEX_RELAY_URL",
	"YTIMESY_CODEX_RELAY_SECRET",
	// Further Codex egress relays, tried in order after the first (2..8).
	...codexRelaySettingNames,
	// The account whose login probes Codex egress paths every 5 minutes.
	"YTIMESY_CODEX_EGRESS_PROBE_USER_ID",
	// Owner alerts go to het@ytimesy.com unless this names another address.
	"YTIMESY_ALERT_EMAIL",
	// OAuth apps for MCP services without dynamic client registration
	// (src/server/services/mcp-oauth-client.ts). Redirect: {APP_URL}/api/mcp/oauth/callback
	"MCP_OAUTH_SLACK_CLIENT_ID",
	"MCP_OAUTH_SLACK_CLIENT_SECRET",
	"MCP_OAUTH_GITHUB_CLIENT_ID",
	"MCP_OAUTH_GITHUB_CLIENT_SECRET",
	// The edge's Ed25519 key for Claude runner-box requests
	// (scripts/generate-claude-runner-keypair.ts); the boxes hold its public key.
	"YTIMESY_CLAUDE_RUNNER_SIGNING_KEY",
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
secrets.DATABASE_SSL_CA = supabaseCertificate(
	process.env,
	certPath ?? undefined,
);

/** Calls that carry secrets (masked) show wrangler's error with every value masked. */
function run(
	command: string,
	args: string[],
	options: { masked?: boolean; env?: object } = {},
) {
	const { masked = false, env } = options;
	try {
		const output = execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, ...env },
		});
		console.log(output);
	} catch (error) {
		const { stdout, stderr } = error as { stdout?: string; stderr?: string };
		let shown = `${stdout ?? ""}${stderr ?? ""}`;
		if (masked)
			for (const value of Object.values(secrets))
				if (value.length >= 4) shown = shown.split(value).join("[redacted]");
		console.error(shown);
		throw new Error(
			"Production deployment failed. Secret material was not logged.",
		);
	}
}
const EDGE_CONFIG = [
	"--config",
	"wrangler.edge-executor.jsonc",
	"--env",
	"production",
];
// The web Worker ships the build output: vite's Cloudflare plugin writes
// dist/server/wrangler.json with the production env already applied, so it
// takes no --env (deploying wrangler.web.jsonc would bundle raw source).
const WEB_CONFIG = ["--config", "dist/server/wrangler.json"];

/**
 * Secret names on a deployed Worker (names only; empty before its first
 * deploy). A rate-limited listing is retried, and any other failure stops the
 * deploy: an unread list must never look like "no secrets", or the preflight
 * reports every hand-set secret as missing.
 */
function deployedSecretNames(config: string[]): string[] {
	const attempts = 6;
	for (let attempt = 1; ; attempt++) {
		try {
			const listed = execFileSync(
				"pnpm",
				["exec", "wrangler", "secret", "list", "--format", "json", ...config],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			return (JSON.parse(listed) as { name: string }[]).map((row) => row.name);
		} catch (error) {
			const output = `${(error as { stdout?: unknown }).stdout ?? ""}${(error as { stderr?: unknown }).stderr ?? ""}${(error as Error).message}`;
			const failure = secretListFailure(output);
			if (failure === "not-deployed") return [];
			if (failure === "rate-limited" && attempt < attempts) {
				const waitMs = 15_000 * attempt;
				console.warn(
					`Cloudflare rate-limited the secret list; retrying in ${waitMs / 1000}s (${attempt}/${attempts - 1}).`,
				);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
				continue;
			}
			// What wrangler said, without colour codes (it names no secret values).
			const said = output
				// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
				.replace(/\u001b\[[0-9;]*m/g, "")
				.split("\n")
				.filter((line) => line.trim())
				.slice(0, 12)
				.join(" | ")
				.slice(0, 700);
			throw new Error(
				`Could not read the Worker's secret names (${failure === "rate-limited" ? "Cloudflare is still rate limiting" : "wrangler secret list failed"}); nothing was deployed. Try again shortly. wrangler said: ${said}`,
			);
		}
	}
}

// Who uploads the Workers: "alchemy" (the infra/alchemy Cloudflare stack,
// through scripts/infra.ts) or, until its first production apply is
// verified, "wrangler". docs/infrastructure-as-code.md has the rollout.
const deployEngine =
	process.env.YTIMESY_DEPLOY_ENGINE === "alchemy" ? "alchemy" : "wrangler";
console.log(`Workers upload with ${deployEngine}.`);

// One production deploy at a time (scripts/deploy-lock.ts).
if (!preflightOnly) {
	const releaseDeployLock = acquireDeployLock("production");
	process.on("exit", releaseDeployLock);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			releaseDeployLock();
			process.exit(130);
		});
}

// One build id for both Workers and the page (src/lib/build-id.ts): the web
// build bakes it in here, the edge's wrangler build reads it from the
// environment. Open tabs reload onto it; the smoke check below expects it.
const buildId = productionBuildId(
	execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
	Date.now(),
);
process.env.YTIMESY_BUILD_ID = buildId;

// Build the web first: its plain variables are part of what it runs with, and
// the preflight below checks both Workers before anything is deployed.
run("pnpm", ["exec", "vite", "build"], {
	env: {
		YTIMESY_TARGET: "cloudflare",
		CLOUDFLARE_ENV: "production",
		// The build's own source guard (vite.config.ts) honours the same override.
		...(allowUnverifiedSource
			? { [ALLOW_UNVERIFIED_SOURCE_VARIABLE]: "1" }
			: {}),
	},
});
const { unstable_readConfig } = await import("wrangler");
const edgeConfig = unstable_readConfig({
	config: "wrangler.edge-executor.jsonc",
	env: "production",
});
const webConfig = unstable_readConfig({ config: "dist/server/wrangler.json" });
const senders = (config: {
	send_email: { allowed_sender_addresses?: string[] }[];
}) =>
	config.send_email.flatMap(
		(binding) => binding.allowed_sender_addresses ?? [],
	);
const webVars: Record<string, string> = Object.fromEntries(
	Object.entries(webConfig.vars ?? {}).map(([name, value]) => [
		name,
		String(value),
	]),
);
// The per-user push hub's users (src/domain/user-hub.ts): the web Worker reads
// them from its vars, the edge executor (which feeds the hubs) gets the same.
if (webVars.YTIMESY_USER_HUB_USERS !== undefined)
	secrets.YTIMESY_USER_HUB_USERS = webVars.YTIMESY_USER_HUB_USERS;
// The web hands background jobs (environment setup included) to the edge over
// signed HTTPS, as the development server wires it (development-server.ts);
// unset, a new project's setup is never handed off and stays queued. A name
// the build already sets as a plain variable (YTIMESY_ENVIRONMENT) cannot
// also be a secret: Cloudflare rejects the whole upload.
const webSecrets: Record<string, string> = Object.fromEntries(
	Object.entries({
		...secrets,
		YTIMESY_ENVIRONMENT_WORKFLOW_URL: secrets.YTIMESY_GIT_PROXY_URL,
		YTIMESY_ENVIRONMENT_WORKFLOW_SECRET: secrets.ENVIRONMENT_WORKFLOW_SECRET,
		YTIMESY_BACKGROUND_WORKFLOW_URL: secrets.YTIMESY_GIT_PROXY_URL,
		YTIMESY_BACKGROUND_WORKFLOW_SECRET: secrets.BACKGROUND_WORKFLOW_SECRET,
		YTIMESY_PR_REPAIR_INGRESS_SECRET: secrets.PR_REPAIR_INGRESS_SECRET,
	}).filter(([name]) => !(name in webVars)),
);

// Preflight: every setting both Workers read, as they will run with it.
const deployed = {
	edge: deployedSecretNames(EDGE_CONFIG),
	web: deployedSecretNames(WEB_CONFIG),
};
const webRuntime = { ...webSecrets, ...webVars };
const problems = productionPreflightProblems({
	web: webRuntime,
	edge: secrets,
	webVars: Object.keys(webVars),
	deployed,
	emailSenders: { web: senders(webConfig), edge: senders(edgeConfig) },
});
if (problems.length)
	throw new Error(
		`Production preflight failed; nothing was deployed:\n- ${problems.join("\n- ")}`,
	);
console.log("Production preflight passed for the web and edge Workers.");
if (preflightOnly) process.exit(0);

/** The versions a Worker serves now (none before its first deploy). */
function currentVersions(config: string[]): ServingVersions {
	try {
		return servingVersions(
			execFileSync(
				"pnpm",
				["exec", "wrangler", "deployments", "status", "--json", ...config],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			),
		);
	} catch {
		return [];
	}
}
const workers = {
	edge: { config: EDGE_CONFIG, previous: currentVersions(EDGE_CONFIG) },
	web: { config: WEB_CONFIG, previous: currentVersions(WEB_CONFIG) },
};
const deployedWorkers: (keyof typeof workers)[] = [];

// Code and secrets go up together as one version per Worker, so new code
// never boots without a setting it needs and each Worker restarts once.
// The secrets files live only for the deploy, readable by this user alone.
const secretsDirectory = await mkdtemp(join(tmpdir(), "ytimesy-deploy-"));
try {
	const edgeSecretsFile = join(secretsDirectory, "edge.json");
	const webSecretsFile = join(secretsDirectory, "web.json");
	await writeFile(edgeSecretsFile, JSON.stringify(secrets), { mode: 0o600 });
	await writeFile(webSecretsFile, JSON.stringify(webSecrets), { mode: 0o600 });
	if (deployEngine === "alchemy") {
		// The same files wrangler would upload (its dry run bundles the edge;
		// the web was built above), uploaded by the infra/alchemy Cloudflare
		// stack with the secrets as one version per Worker. scripts/infra.ts
		// plans first and refuses any removal, replacement or lost binding.
		run(
			"pnpm",
			[
				"exec",
				"wrangler",
				"deploy",
				"--dry-run",
				"--outdir",
				".ytimesy/edge-upload",
				...EDGE_CONFIG,
			],
			{ masked: true },
		);
		const infraSecretsFile = join(secretsDirectory, "infra.json");
		await writeFile(
			infraSecretsFile,
			JSON.stringify({ edge: secrets, web: webSecrets }),
			{ mode: 0o600 },
		);
		run(
			"node",
			[
				"--import",
				"tsx",
				"scripts/infra.ts",
				"deploy",
				"cloudflare",
				"--stage",
				"production",
				"--prebuilt",
				"--confirm-production",
				"--secrets-file",
				infraSecretsFile,
				...(process.env.YTIMESY_INFRA_ADOPT === "1"
					? ["--adopt-existing"]
					: []),
			],
			{ masked: true },
		);
		deployedWorkers.push("edge", "web");
	} else {
		// Masked like a stdin secret call: wrangler's error never shows a value.
		for (const args of productionDeploySteps({
			edgeConfig: EDGE_CONFIG,
			webConfig: WEB_CONFIG,
			edgeSecretsFile,
			webSecretsFile,
		})) {
			run("pnpm", ["exec", "wrangler", ...args], { masked: true });
			deployedWorkers.push(args.includes(edgeSecretsFile) ? "edge" : "web");
		}
	}
} finally {
	await rm(secretsDirectory, { recursive: true, force: true });
}

// Smoke check: each Worker answers with this build, retried for about a
// minute while the new versions reach every location. Otherwise every Worker
// deployed above goes back to what it served before, web first.
const smokeProblems = await runSmokeChecks(
	productionSmokeChecks({
		appUrl: process.env.YTIMESY_GO_LIVE === "1" ? secrets.APP_URL : null,
		edgeUrl: secrets.YTIMESY_GIT_PROXY_URL,
		buildId,
	}),
	async (url) => {
		const response = await fetch(url, {
			headers: { "cache-control": "no-cache" },
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		return {
			status: response.status,
			headers: response.headers,
			body: await response.text(),
		};
	},
	{ attempts: 7, delayMs: 10_000, log: (line) => console.log(line) },
);
// The Workers must still carry the bindings they cannot work without (the
// Codex egress network); a deploy that dropped one is rolled back like a
// failed smoke check (2026-11-25 incident review).
const cloudflareToken =
	process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_DEPLOY_TOKEN;
smokeProblems.push(
	...(cloudflareToken
		? await liveWorkerBindingProblems(cloudflareToken)
		: ["No Cloudflare token to check the live Worker bindings."]),
);
if (smokeProblems.length) {
	console.error(
		`Production smoke check failed for build ${buildId}:\n- ${smokeProblems.join("\n- ")}`,
	);
	const notRolledBack: string[] = [];
	for (const name of [...deployedWorkers].reverse()) {
		const { config, previous } = workers[name];
		if (!previous.length) {
			notRolledBack.push(`${name}: no earlier version to roll back to`);
			continue;
		}
		const step = rollbackStep(config, previous);
		try {
			run("pnpm", ["exec", "wrangler", ...step], { masked: true });
			console.error(
				`Rolled ${name} back to ${previous.map((row) => `${row.versionId} (${row.percentage}%)`).join(", ")}.`,
			);
		} catch {
			const command = step
				.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
				.join(" ");
			notRolledBack.push(
				`${name}: rollback failed; run pnpm exec wrangler ${command}`,
			);
		}
	}
	if (notRolledBack.length)
		console.error(`Not rolled back:\n- ${notRolledBack.join("\n- ")}`);
	process.exit(1);
}
console.log(`Production smoke check passed for build ${buildId}.`);

// The turn box program goes out with the edge it talks to (boxes move to
// it once their running turns finish; an unchanged program is the same
// object and moves nobody). Bookkeeping-style: a failed publish is reported,
// it does not undo the deploy, and the next deploy publishes again.
try {
	run("node", ["--import", "tsx", "scripts/publish-turn-box.ts"], {
		masked: true,
		env: {
			CLOUDFLARE_API_TOKEN:
				process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_DEPLOY_TOKEN,
		},
	});
} catch {
	console.error(
		"The turn box program was not published; boxes keep the previous one. Run node --import tsx scripts/publish-turn-box.ts.",
	);
}

// What actually landed: every required name on each Worker.
const missing = [
	...missingDeployedSettings({
		required: requiredSettingNames("edge", secrets),
		secrets: deployedSecretNames(EDGE_CONFIG),
		vars: [],
	}).map((name) => `edge: ${name}`),
	...missingDeployedSettings({
		required: requiredSettingNames("web", webRuntime),
		secrets: deployedSecretNames(WEB_CONFIG),
		vars: Object.keys(webVars),
	}).map((name) => `web: ${name}`),
];
if (missing.length)
	throw new Error(
		`Production deployed but a Worker lacks settings:\n- ${missing.join("\n- ")}`,
	);
console.log(
	process.env.YTIMESY_GO_LIVE === "1"
		? `Production deployed and live at ${secrets.APP_URL}.`
		: "Production deployed with no public app route.",
);
console.log(IN_FLIGHT_WORK_NOTE);
