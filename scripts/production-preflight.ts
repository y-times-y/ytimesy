/**
 * The production deploy's preflight: every setting the web and edge Workers
 * read at runtime, checked against the exact values the deploy is about to
 * upload (plus the web build's plain variables and the secrets set by hand),
 * before anything ships. Pure, so tests/production-preflight.test.ts covers
 * it; scripts/deploy-production.ts runs it and refuses on any problem.
 *
 * Kept in step with what the code requires: src/server/config.ts (both
 * Workers), the executor's schemas in src/server/edge/executor.ts and
 * project-environment.ts (edge), turnstile.ts, background-job-dispatch.ts,
 * git-proxy-transfer.ts and realtime-delivery.ts (web).
 */
import { createHmac } from "node:crypto";

export type ProductionWorker = "web" | "edge";
type Settings = Readonly<Record<string, string | undefined>>;
type Check = (value: string, settings: Settings) => string | null;

const BOTH: readonly ProductionWorker[] = ["web", "edge"];
const WEB: readonly ProductionWorker[] = ["web"];
const EDGE: readonly ProductionWorker[] = ["edge"];

const minLength =
	(length: number): Check =>
	(value) =>
		value.length >= length ? null : `must be at least ${length} characters`;
const exactly =
	(expected: string): Check =>
	(value) =>
		value === expected ? null : `must be "${expected}"`;
const matches =
	(pattern: RegExp, description: string): Check =>
	(value) =>
		pattern.test(value) ? null : description;
const positiveInteger = matches(/^[1-9]\d*$/, "must be a positive integer");

/** An origin the Workers sign requests to: HTTPS, no path, never development. */
const productionOrigin: Check = (value) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "must be a URL";
	}
	if (url.protocol !== "https:") return "must be HTTPS";
	if (/workers\.dev$|localhost|^127\./.test(url.hostname))
		return "must be a production hostname, not workers.dev or loopback";
	if (url.pathname !== "/" || url.search || url.hash || url.username)
		return "must be a bare origin (no path, query or credentials)";
	return null;
};

/** src/server/config.ts refuses anything else, and the edge has no Hyperdrive bypass. */
const databaseUrl: Check = (value) => {
	try {
		const url = new URL(value);
		if (!["postgres:", "postgresql:"].includes(url.protocol))
			return "must be a PostgreSQL URL";
		if (url.searchParams.get("sslmode") !== "verify-full")
			return "needs sslmode=verify-full (the edge's config check)";
		return null;
	} catch {
		return "must be a PostgreSQL URL";
	}
};

const secretsKey: Check = (value) => {
	const bytes = Buffer.from(
		value,
		/^[a-f0-9]{64}$/i.test(value) ? "hex" : "base64",
	);
	return bytes.length === 32 ? null : "must be 32 bytes (hex or base64)";
};

type Rule = {
	readonly name: string;
	readonly workers: readonly ProductionWorker[];
	readonly check?: Check;
	/** Only required when this returns true for that Worker's settings. */
	readonly when?: (settings: Settings) => boolean;
};

/** Every setting a production Worker needs to boot and serve its features. */
export const PRODUCTION_RULES: readonly Rule[] = [
	{ name: "YTIMESY_ENVIRONMENT", workers: BOTH, check: exactly("production") },
	{ name: "APP_URL", workers: BOTH, check: productionOrigin },
	{ name: "BETTER_AUTH_SECRET", workers: BOTH, check: minLength(32) },
	{ name: "DATABASE_URL", workers: BOTH, check: databaseUrl },
	{
		name: "DATABASE_SSL_CA",
		workers: BOTH,
		check: matches(/-----BEGIN CERTIFICATE-----/, "must be a PEM certificate"),
		when: (settings) =>
			Boolean(
				settings.DATABASE_URL &&
					URL.canParse(settings.DATABASE_URL) &&
					new URL(settings.DATABASE_URL).searchParams.get("sslrootcert"),
			),
	},
	{
		name: "YTIMESY_DATABASE_VIA_HYPERDRIVE",
		workers: WEB,
		check: exactly("1"),
	},
	{ name: "FREESTYLE_API_KEY", workers: BOTH },
	{
		name: "GITHUB_APP_ID",
		workers: BOTH,
		check: matches(/^\d+$/, "must be numeric"),
	},
	{
		name: "GITHUB_PRIVATE_KEY",
		workers: BOTH,
		check: matches(/-----BEGIN PRIVATE KEY-----/, "must be a PKCS#8 PEM key"),
	},
	{ name: "GITHUB_APP_CLIENT_ID", workers: BOTH },
	{ name: "GITHUB_APP_CLIENT_SECRET", workers: BOTH },
	{ name: "GITHUB_OAUTH_CLIENT_ID", workers: BOTH },
	{ name: "GITHUB_OAUTH_CLIENT_SECRET", workers: BOTH },
	{
		name: "GITHUB_APP_SLUG",
		workers: BOTH,
		check: matches(/^[a-z0-9-]+$/, "must be the App's slug"),
	},
	{
		name: "GITHUB_APP_BOT_USER_ID",
		workers: BOTH,
		check: matches(/^\d+$/, "must be numeric"),
	},
	{ name: "YTIMESY_SECRETS_KEY", workers: BOTH, check: secretsKey },
	{ name: "YTIMESY_GIT_PROXY_URL", workers: BOTH, check: productionOrigin },
	{ name: "YTIMESY_GIT_PROXY_SECRET", workers: BOTH, check: minLength(32) },
	{ name: "YTIMESY_REALTIME_URL", workers: BOTH, check: productionOrigin },
	{ name: "YTIMESY_REALTIME_SECRET", workers: BOTH, check: minLength(32) },
	{
		name: "YTIMESY_MODEL_EXECUTION_TARGET",
		workers: BOTH,
		check: exactly("durable-object"),
	},
	{
		name: "AUTH_EMAIL_FROM",
		workers: BOTH,
		check: matches(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "must be an email address"),
	},
	{
		name: "R2_ACCOUNT_ID",
		workers: BOTH,
		check: matches(/^[a-f0-9]{32}$/i, "must be a Cloudflare account id"),
	},
	{ name: "R2_ACCESS_KEY_ID", workers: BOTH },
	{ name: "R2_SECRET_ACCESS_KEY", workers: BOTH },
	{ name: "R2_CHECKPOINT_BUCKET", workers: BOTH },
	{ name: "POSTHOG_PROJECT_TOKEN", workers: BOTH },
	{ name: "YTIMESY_USER_5H_MICRO_USD", workers: BOTH, check: positiveInteger },
	{
		name: "YTIMESY_USER_WEEKLY_MICRO_USD",
		workers: BOTH,
		check: positiveInteger,
	},
	{
		name: "YTIMESY_FLEET_MONTHLY_MICRO_USD",
		workers: BOTH,
		check: positiveInteger,
	},
	{
		name: "YTIMESY_FLEET_LIFETIME_MICRO_USD",
		workers: BOTH,
		check: positiveInteger,
	},
	// Edge executor schemas (src/server/edge/executor.ts).
	{ name: "MODEL_WORKFLOW_SECRET", workers: EDGE, check: minLength(32) },
	{ name: "GIT_PROXY_SECRET", workers: EDGE, check: minLength(32) },
	{ name: "ENVIRONMENT_WORKFLOW_SECRET", workers: EDGE, check: minLength(32) },
	{ name: "BACKGROUND_WORKFLOW_SECRET", workers: EDGE, check: minLength(32) },
	{ name: "PR_REPAIR_INGRESS_SECRET", workers: EDGE, check: minLength(32) },
	{ name: "GIT_PROXY_ENABLED", workers: EDGE, check: exactly("1") },
	{ name: "MODEL_EXECUTION_ENABLED", workers: EDGE, check: exactly("1") },
	{ name: "ENVIRONMENT_EXECUTION_ENABLED", workers: EDGE, check: exactly("1") },
	{ name: "BACKGROUND_EXECUTION_ENABLED", workers: EDGE, check: exactly("1") },
	{
		name: "YTIMESY_BACKGROUND_CRON_ENABLED",
		workers: EDGE,
		check: exactly("1"),
	},
	// The web hands background jobs (environment setup included) and turns to
	// the edge over signed HTTPS; unset, they stay queued forever.
	{
		name: "YTIMESY_BACKGROUND_WORKFLOW_URL",
		workers: WEB,
		check: productionOrigin,
	},
	{
		name: "YTIMESY_BACKGROUND_WORKFLOW_SECRET",
		workers: WEB,
		check: minLength(32),
	},
	// Production sign-in throws without both (src/server/auth/turnstile.ts).
	{ name: "TURNSTILE_SITE_KEY", workers: WEB },
	{ name: "TURNSTILE_SECRET_KEY", workers: WEB },
	{
		name: "GITHUB_PR_REPAIR_WEBHOOK_SECRET",
		workers: WEB,
		when: (settings) => settings.YTIMESY_PR_REPAIR_ENABLED === "1",
	},
	{
		name: "GOOGLE_CLIENT_SECRET",
		workers: BOTH,
		when: (settings) => Boolean(settings.GOOGLE_CLIENT_ID),
	},
	{
		name: "GOOGLE_CLIENT_ID",
		workers: BOTH,
		when: (settings) => Boolean(settings.GOOGLE_CLIENT_SECRET),
	},
];

/**
 * Set by hand with `wrangler secret put` on both production Workers and never
 * uploaded by the deploy (the only copies are Cloudflare's and the owner's
 * password manager). Both must hold the same value.
 */
export const HAND_SET_SECRETS = ["TOKEN_VAULT_KEY"] as const;

/** Development and evaluation switches that must never reach production. */
export function isDevelopmentOnlySetting(name: string) {
	return (
		/^YTIMESY_(DEV|DEBUG)_/.test(name) ||
		[
			"YTIMESY_HARNESS_EVALUATION_ENABLED",
			"YTIMESY_EVALUATION_CHECKPOINT_DIR",
			// Operator proofs only: the web then starts turns on a raw Workflow URL.
			"YTIMESY_MODEL_WORKFLOW_URL",
			"YTIMESY_MODEL_WORKFLOW_SECRET",
		].includes(name)
	);
}

/** Purposes the development deploys derive under `ytimesy:<purpose>:development:v1`. */
const DEVELOPMENT_DERIVED_PURPOSES = [
	"model-workflows",
	"git-proxy",
	"environment-workflows",
	"background-workflows",
	"pr-repair-ingress",
	"realtime",
];

/** Settings each Worker requires (for the post-deploy name check). */
export function requiredSettingNames(
	worker: ProductionWorker,
	settings: Settings,
): string[] {
	return [
		...PRODUCTION_RULES.filter(
			(rule) =>
				rule.workers.includes(worker) && (!rule.when || rule.when(settings)),
		).map((rule) => rule.name),
		...HAND_SET_SECRETS,
	];
}

export type PreflightInput = {
	/** What each Worker will run with: uploaded secrets plus plain variables. */
	readonly web: Settings;
	readonly edge: Settings;
	/** Plain variables in the web build (dist/server/wrangler.json). */
	readonly webVars: readonly string[];
	/** Secret names already on each deployed Worker (hand-set ones live only there). */
	readonly deployed: Readonly<Record<ProductionWorker, readonly string[]>>;
	/** Each Worker's send_email allowed_sender_addresses. */
	readonly emailSenders: Readonly<Record<ProductionWorker, readonly string[]>>;
};

/** Every reason this deploy would ship a Worker missing or misreading config. */
export function productionPreflightProblems(input: PreflightInput): string[] {
	const problems: string[] = [];
	for (const worker of BOTH) {
		const settings = input[worker];
		for (const rule of PRODUCTION_RULES) {
			if (!rule.workers.includes(worker)) continue;
			if (rule.when && !rule.when(settings)) continue;
			const value = settings[rule.name]?.trim();
			if (!value) {
				problems.push(`${worker}: ${rule.name} is missing`);
				continue;
			}
			const problem = rule.check?.(value, settings);
			if (problem) problems.push(`${worker}: ${rule.name} ${problem}`);
		}
		for (const name of HAND_SET_SECRETS)
			if (!input.deployed[worker].includes(name) && !settings[name])
				problems.push(
					`${worker}: ${name} is missing; set it by hand on both production Workers (wrangler secret put ${name})`,
				);
		for (const name of new Set([
			...Object.keys(settings).filter((name) => settings[name]),
			...input.deployed[worker],
		]))
			if (isDevelopmentOnlySetting(name))
				problems.push(
					`${worker}: ${name} is a development-only setting${
						input.deployed[worker].includes(name)
							? ` (delete it: wrangler secret delete ${name})`
							: ""
					}`,
				);
		const sender = settings.AUTH_EMAIL_FROM;
		if (sender && !input.emailSenders[worker].includes(sender))
			problems.push(
				`${worker}: AUTH_EMAIL_FROM is not an allowed sender of its EMAIL binding`,
			);
		const root = settings.BETTER_AUTH_SECRET;
		if (root && root.length >= 32) {
			const developmentKeys = new Set(
				DEVELOPMENT_DERIVED_PURPOSES.map((purpose) =>
					createHmac("sha256", root)
						.update(`ytimesy:${purpose}:development:v1`)
						.digest("hex"),
				),
			);
			for (const [name, value] of Object.entries(settings))
				if (value && developmentKeys.has(value))
					problems.push(
						`${worker}: ${name} is a development-labelled key; derive it with the production label`,
					);
		}
	}
	// The web and the edge must agree on every shared key and endpoint.
	const pairs: [string, string][] = [
		["YTIMESY_BACKGROUND_WORKFLOW_SECRET", "BACKGROUND_WORKFLOW_SECRET"],
		["YTIMESY_BACKGROUND_WORKFLOW_URL", "YTIMESY_GIT_PROXY_URL"],
		["YTIMESY_GIT_PROXY_SECRET", "GIT_PROXY_SECRET"],
		...[
			"YTIMESY_GIT_PROXY_URL",
			"YTIMESY_GIT_PROXY_SECRET",
			"YTIMESY_REALTIME_URL",
			"YTIMESY_REALTIME_SECRET",
			"BETTER_AUTH_SECRET",
			"YTIMESY_SECRETS_KEY",
			"APP_URL",
			"GITHUB_APP_ID",
			"GITHUB_APP_SLUG",
			"GITHUB_PRIVATE_KEY",
			"R2_CHECKPOINT_BUCKET",
		].map((name): [string, string] => [name, name]),
	];
	for (const [webName, edgeName] of pairs) {
		const web = input.web[webName];
		const edge = input.edge[edgeName];
		if (web && edge && web !== edge)
			problems.push(`web ${webName} differs from edge ${edgeName}`);
	}
	return problems;
}

/** Required names a deployed Worker still lacks (secrets listed after upload, plus its vars). */
export function missingDeployedSettings(input: {
	readonly required: readonly string[];
	readonly secrets: readonly string[];
	readonly vars: readonly string[];
}): string[] {
	const present = new Set([...input.secrets, ...input.vars]);
	return input.required.filter((name) => !present.has(name));
}

/**
 * Why `wrangler secret list` failed, from its output: a Worker that was never
 * deployed has no secrets (the first deploy), a rate limit is worth waiting
 * out, and anything else (auth, network) must stop the deploy. Reading any of
 * them as "no secrets" made a rate-limited listing report hand-set secrets as
 * missing.
 */
export function secretListFailure(
	output: string,
): "not-deployed" | "rate-limited" | "other" {
	if (/\b10429\b|rate limited/i.test(output)) return "rate-limited";
	if (/\b10007\b|script not found|workers?\.?.*does not exist/i.test(output))
		return "not-deployed";
	return "other";
}
