import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { edgeSigningSecret } from "#/domain/edge-signing-secret";
import {
	missingDeployedSettings,
	type PreflightInput,
	productionPreflightProblems,
	requiredSettingNames,
} from "../scripts/production-preflight";

const root = "r".repeat(64);
const derived = (purpose: string, label = "production") =>
	createHmac("sha256", root)
		.update(`ytimesy:${purpose}:${label}:v1`)
		.digest("hex");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 1024 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();
const certificate =
	"-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

/** Both Workers as a correct deploy configures them. */
function valid(): PreflightInput {
	const shared = {
		YTIMESY_ENVIRONMENT: "production",
		APP_URL: "https://ytimesy.com",
		BETTER_AUTH_SECRET: root,
		DATABASE_URL:
			"postgresql://postgres.prod:pw@db.example.com:6543/postgres?sslmode=verify-full&sslrootcert=/tmp/ca.crt",
		DATABASE_SSL_CA: certificate,
		FREESTYLE_API_KEY: "freestyle",
		GITHUB_APP_ID: "4932652",
		GITHUB_PRIVATE_KEY: privateKey,
		GITHUB_APP_CLIENT_ID: "Iv23app",
		GITHUB_APP_CLIENT_SECRET: "app-secret",
		GITHUB_OAUTH_CLIENT_ID: "Ov23oauth",
		GITHUB_OAUTH_CLIENT_SECRET: "oauth-secret",
		GITHUB_APP_SLUG: "ytimesy-agent",
		GITHUB_APP_BOT_USER_ID: "328807657",
		YTIMESY_SECRETS_KEY: randomBytes(32).toString("hex"),
		YTIMESY_GIT_PROXY_URL: "https://edge.ytimesy.com",
		YTIMESY_GIT_PROXY_SECRET: derived("git-proxy"),
		YTIMESY_REALTIME_URL: "https://edge.ytimesy.com",
		YTIMESY_REALTIME_SECRET: derived("realtime"),
		YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
		AUTH_EMAIL_FROM: "noreply@ytimesy.com",
		R2_ACCOUNT_ID: "00000000000000000000000000000000",
		R2_ACCESS_KEY_ID: "r2-id",
		R2_SECRET_ACCESS_KEY: "r2-secret",
		R2_CHECKPOINT_BUCKET: "ytimesy-checkpoints-production",
		POSTHOG_PROJECT_TOKEN: "phc_token",
		YTIMESY_USER_5H_MICRO_USD: "5000000",
		YTIMESY_USER_WEEKLY_MICRO_USD: "25000000",
		YTIMESY_FLEET_MONTHLY_MICRO_USD: "100000000",
		YTIMESY_FLEET_LIFETIME_MICRO_USD: "500000000",
		YTIMESY_PR_REPAIR_ENABLED: "1",
		GOOGLE_CLIENT_ID: "google-id",
		GOOGLE_CLIENT_SECRET: "google-secret",
	};
	const edge = {
		...shared,
		MODEL_WORKFLOW_SECRET: derived("model-workflows"),
		GIT_PROXY_SECRET: derived("git-proxy"),
		ENVIRONMENT_WORKFLOW_SECRET: derived("environment-workflows"),
		BACKGROUND_WORKFLOW_SECRET: derived("background-workflows"),
		PR_REPAIR_INGRESS_SECRET: derived("pr-repair-ingress"),
		GIT_PROXY_ENABLED: "1",
		MODEL_EXECUTION_ENABLED: "1",
		ENVIRONMENT_EXECUTION_ENABLED: "1",
		BACKGROUND_EXECUTION_ENABLED: "1",
		YTIMESY_BACKGROUND_CRON_ENABLED: "1",
	};
	const web = {
		...edge,
		YTIMESY_DATABASE_VIA_HYPERDRIVE: "1",
		YTIMESY_BACKGROUND_WORKFLOW_URL: "https://edge.ytimesy.com",
		YTIMESY_BACKGROUND_WORKFLOW_SECRET: derived("background-workflows"),
		TURNSTILE_SITE_KEY: "0xsite",
		TURNSTILE_SECRET_KEY: "0xsecret",
		GITHUB_PR_REPAIR_WEBHOOK_SECRET: "webhook-secret",
	};
	return {
		web,
		edge,
		webVars: ["YTIMESY_DATABASE_VIA_HYPERDRIVE", "YTIMESY_ENVIRONMENT"],
		deployed: { web: ["TOKEN_VAULT_KEY"], edge: ["TOKEN_VAULT_KEY"] },
		emailSenders: {
			web: ["noreply@ytimesy.com"],
			edge: ["noreply@ytimesy.com"],
		},
	};
}

function without(
	input: PreflightInput,
	worker: "web" | "edge",
	name: string,
): PreflightInput {
	const settings = { ...input[worker] };
	delete settings[name];
	return { ...input, [worker]: settings };
}

function withSetting(
	input: PreflightInput,
	worker: "web" | "edge",
	name: string,
	value: string,
): PreflightInput {
	return { ...input, [worker]: { ...input[worker], [name]: value } };
}

describe("production preflight", () => {
	it("passes a correctly configured deploy", () => {
		expect(productionPreflightProblems(valid())).toEqual([]);
	});

	it("refuses the gaps production shipped with", () => {
		// The web had no edge handoff (environment setup stayed queued).
		for (const name of [
			"YTIMESY_BACKGROUND_WORKFLOW_URL",
			"YTIMESY_BACKGROUND_WORKFLOW_SECRET",
		])
			expect(
				productionPreflightProblems(without(valid(), "web", name)),
			).toContain(`web: ${name} is missing`);
		// The web got no secrets at all.
		const bare = { ...valid(), web: { YTIMESY_ENVIRONMENT: "production" } };
		expect(productionPreflightProblems(bare).length).toBeGreaterThan(20);
		// DATABASE_URL without sslmode=verify-full fails the edge's config check.
		const problems = productionPreflightProblems(
			withSetting(
				valid(),
				"edge",
				"DATABASE_URL",
				"postgresql://u:p@db.example.com:5432/postgres?sslmode=require",
			),
		);
		expect(problems).toContain(
			"edge: DATABASE_URL needs sslmode=verify-full (the edge's config check)",
		);
	});

	it("checks every edge executor schema setting", () => {
		for (const name of [
			"MODEL_WORKFLOW_SECRET",
			"GIT_PROXY_SECRET",
			"ENVIRONMENT_WORKFLOW_SECRET",
			"BACKGROUND_WORKFLOW_SECRET",
			"PR_REPAIR_INGRESS_SECRET",
			"GIT_PROXY_ENABLED",
			"MODEL_EXECUTION_ENABLED",
			"ENVIRONMENT_EXECUTION_ENABLED",
			"BACKGROUND_EXECUTION_ENABLED",
			"YTIMESY_ENVIRONMENT",
		])
			expect(
				productionPreflightProblems(without(valid(), "edge", name)),
			).toContain(`edge: ${name} is missing`);
		expect(
			productionPreflightProblems(
				withSetting(valid(), "edge", "MODEL_EXECUTION_ENABLED", "0"),
			),
		).toContain('edge: MODEL_EXECUTION_ENABLED must be "1"');
	});

	it("requires Turnstile on the web, and the webhook secret when PR repair is on", () => {
		expect(
			productionPreflightProblems(
				without(valid(), "web", "TURNSTILE_SITE_KEY"),
			),
		).toContain("web: TURNSTILE_SITE_KEY is missing");
		const noWebhook = without(
			valid(),
			"web",
			"GITHUB_PR_REPAIR_WEBHOOK_SECRET",
		);
		expect(productionPreflightProblems(noWebhook)).toContain(
			"web: GITHUB_PR_REPAIR_WEBHOOK_SECRET is missing",
		);
		expect(
			productionPreflightProblems(
				withSetting(noWebhook, "web", "YTIMESY_PR_REPAIR_ENABLED", "0"),
			),
		).toEqual([]);
	});

	it("refuses development endpoints, malformed values and development-labelled keys", () => {
		const problems = productionPreflightProblems(
			withSetting(
				withSetting(
					withSetting(
						valid(),
						"web",
						"YTIMESY_BACKGROUND_WORKFLOW_URL",
						"https://ytimesy-edge-executor-development.example-account.workers.dev",
					),
					"edge",
					"GITHUB_APP_BOT_USER_ID",
					"ytimesy-agent[bot]",
				),
				"edge",
				"GIT_PROXY_SECRET",
				derived("git-proxy", "development"),
			),
		);
		expect(problems).toContain(
			"web: YTIMESY_BACKGROUND_WORKFLOW_URL must be a production hostname, not workers.dev or loopback",
		);
		expect(problems).toContain("edge: GITHUB_APP_BOT_USER_ID must be numeric");
		expect(problems).toContain(
			"edge: GIT_PROXY_SECRET is a development-labelled key; derive it with the production label",
		);
	});

	it("refuses web and edge keys that disagree", () => {
		expect(
			productionPreflightProblems(
				withSetting(
					valid(),
					"web",
					"YTIMESY_BACKGROUND_WORKFLOW_SECRET",
					"x".repeat(64),
				),
			),
		).toContain(
			"web YTIMESY_BACKGROUND_WORKFLOW_SECRET differs from edge BACKGROUND_WORKFLOW_SECRET",
		);
	});

	it("requires the hand-set token vault key on both Workers", () => {
		const input = valid();
		expect(
			productionPreflightProblems({
				...input,
				deployed: { web: ["TOKEN_VAULT_KEY"], edge: [] },
			}),
		).toContain(
			"edge: TOKEN_VAULT_KEY is missing; set it by hand on both production Workers (wrangler secret put TOKEN_VAULT_KEY)",
		);
	});

	it("refuses development-only switches, uploaded or already deployed", () => {
		const input = valid();
		const problems = productionPreflightProblems({
			...withSetting(input, "edge", "YTIMESY_DEV_EVAL_USERS", "1"),
			deployed: {
				web: ["TOKEN_VAULT_KEY", "YTIMESY_DEBUG_TURN_ERRORS"],
				edge: ["TOKEN_VAULT_KEY"],
			},
		});
		expect(problems).toContain(
			"edge: YTIMESY_DEV_EVAL_USERS is a development-only setting",
		);
		expect(problems).toContain(
			"web: YTIMESY_DEBUG_TURN_ERRORS is a development-only setting (delete it: wrangler secret delete YTIMESY_DEBUG_TURN_ERRORS)",
		);
	});

	it("requires the email sender to be one the EMAIL binding allows", () => {
		expect(
			productionPreflightProblems({
				...valid(),
				emailSenders: { web: ["noreply@ytimesy.com"], edge: [] },
			}),
		).toContain(
			"edge: AUTH_EMAIL_FROM is not an allowed sender of its EMAIL binding",
		);
	});

	it("lists required names a deployed Worker still lacks", () => {
		const input = valid();
		const required = requiredSettingNames("web", input.web);
		expect(required).toContain("YTIMESY_BACKGROUND_WORKFLOW_URL");
		expect(required).toContain("TOKEN_VAULT_KEY");
		expect(requiredSettingNames("edge", input.edge)).not.toContain(
			"TURNSTILE_SITE_KEY",
		);
		expect(
			missingDeployedSettings({
				required,
				secrets: required.filter(
					(name) =>
						name !== "YTIMESY_ENVIRONMENT" &&
						name !== "YTIMESY_BACKGROUND_WORKFLOW_SECRET",
				),
				vars: ["YTIMESY_ENVIRONMENT"],
			}),
		).toEqual(["YTIMESY_BACKGROUND_WORKFLOW_SECRET"]);
	});
});

describe("edge signing secrets", () => {
	it("derives the development-labelled key outside production", () => {
		expect(
			edgeSigningSecret("YTIMESY_GIT_PROXY_SECRET", "git-proxy", {
				BETTER_AUTH_SECRET: root,
			}),
		).toBe(derived("git-proxy", "development"));
	});

	it("never derives in production; a missing key fails loudly", () => {
		expect(() =>
			edgeSigningSecret("YTIMESY_GIT_PROXY_SECRET", "git-proxy", {
				BETTER_AUTH_SECRET: root,
				YTIMESY_ENVIRONMENT: "production",
			}),
		).toThrow("Production requires YTIMESY_GIT_PROXY_SECRET");
		expect(
			edgeSigningSecret("YTIMESY_GIT_PROXY_SECRET", "git-proxy", {
				BETTER_AUTH_SECRET: root,
				YTIMESY_ENVIRONMENT: "production",
				YTIMESY_GIT_PROXY_SECRET: derived("git-proxy"),
			}),
		).toBe(derived("git-proxy"));
	});
});
