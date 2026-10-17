import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { App } from "octokit";
import { closeDatabase, database } from "#/server/adapters/database";
import { readGitHubAppCredentials } from "#/server/adapters/github/credentials";
import { modelWorkflowSigningSecret } from "#/server/adapters/model-workflow-dispatch";
import {
	DEVELOPMENT_EDGE_ORIGIN,
	WORKERS_DEV_SUBDOMAIN,
} from "./development-config";

const developmentRef = "exampledevprojectref";
const config = "wrangler.pr-repair.jsonc";
const endpoint = `https://ytimesy-pr-repair-development.${WORKERS_DEV_SUBDOMAIN}/github-repair`;
const repository = "repos/y-times-y/ytimesy";
const edgeOrigin = DEVELOPMENT_EDGE_ORIGIN;

function command(args: string[], input?: string, env = process.env) {
	const result = spawnSync("pnpm", args, {
		env,
		input,
		stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
	});
	if (result.status !== 0)
		throw new Error("Development repair deployment command failed.");
}

function github<T>(args: string[], input?: object): T {
	const result = spawnSync("gh", ["api", ...args], {
		input: input ? JSON.stringify(input) : undefined,
		encoding: "utf8",
		stdio: "pipe",
	});
	if (result.status !== 0)
		throw new Error("Development repository webhook operation failed.");
	return JSON.parse(result.stdout) as T;
}

/** Forwards to the development edge executor; never creates compute or changes the shared App hook. */
async function main() {
	if (!process.argv.includes("--apply"))
		throw new Error("Explicit --apply is required.");
	const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
	if (
		linked !== developmentRef ||
		!new URL(process.env.DATABASE_URL ?? "").username.includes(developmentRef)
	)
		throw new Error("Not the approved development database.");
	try {
		const active = await database().query(
			"select 1 from api_turn where state='running' limit 1",
		);
		if (active.rowCount)
			throw new Error("Finish active model turns before deploying.");
		const migration = await database().query(
			"select 1 from supabase_migrations.schema_migrations where version='20261005160000'",
		);
		if (!migration.rowCount)
			throw new Error(
				"Apply and verify the development repair migration first.",
			);
	} finally {
		await closeDatabase();
	}
	const credentials = await Effect.runPromise(readGitHubAppCredentials());
	const app = new App({
		appId: credentials.appId,
		privateKey: credentials.privateKey,
	});
	const installations = await app.octokit.request("GET /app/installations");
	const installation = installations.data.find(
		(item) => item.account?.login === "y-times-y",
	);
	if (installation?.permissions.checks !== "read")
		throw new Error("The development installation must approve Checks: read.");
	const repo = github<{ permissions?: { admin?: boolean } }>([repository]);
	if (!repo.permissions?.admin)
		throw new Error("Development webhook administration unavailable.");
	const hooks = github<Array<{ id: number; config: { url?: string } }>>([
		`${repository}/hooks?per_page=100`,
	]);
	if (hooks.length === 100)
		throw new Error("Webhook inventory requires pagination before mutation.");
	const matches = hooks.filter((hook) => hook.config.url === endpoint);
	if (matches.length > 1)
		throw new Error(
			"Duplicate development hooks require manual reconciliation.",
		);
	if (matches.length)
		throw new Error(
			"A development hook already exists. Preserve its signing key or perform an explicit coordinated rotation; this bootstrap will not replace it.",
		);
	const secret = randomBytes(32).toString("hex");
	const secretsDirectory = await mkdtemp(
		join(tmpdir(), "ytimesy-repair-secrets-"),
	);
	const secretsFile = join(secretsDirectory, "secrets.json");
	try {
		await writeFile(
			secretsFile,
			JSON.stringify({
				GITHUB_PR_REPAIR_WEBHOOK_SECRET: secret,
				MODEL_WORKFLOW_SECRET: modelWorkflowSigningSecret(),
			}),
			{ mode: 0o600 },
		);
		command([
			"exec",
			"wrangler",
			"deploy",
			"--config",
			config,
			"--var",
			`REPAIR_EXECUTOR_URL:${edgeOrigin}`,
			"--secrets-file",
			secretsFile,
		]);
	} finally {
		await rm(secretsDirectory, { recursive: true, force: true });
	}
	const body = JSON.stringify({ zen: "Development repair ingress proof" });
	const unsigned = await fetch(endpoint, {
		method: "POST",
		body,
		signal: AbortSignal.timeout(15000),
	});
	await unsigned.body?.cancel();
	if (unsigned.status !== 401)
		throw new Error("Unsigned remote delivery was not rejected.");
	const signed = await fetch(endpoint, {
		method: "POST",
		headers: {
			"x-github-event": "ping",
			"x-github-delivery": randomUUID(),
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		},
		body,
		signal: AbortSignal.timeout(15000),
	});
	const result = (await signed.json()) as { ignored?: boolean };
	if (signed.status !== 200 || result.ignored !== true)
		throw new Error("Signed remote ping was not safely ignored.");
	if (!process.argv.includes("--enable")) {
		console.info(
			"Ingress verified; repository hook and repair execution not enabled.",
		);
		return;
	}
	command(["exec", "tsx", "scripts/deploy-edge-development.ts"], undefined, {
		...process.env,
		YTIMESY_PR_REPAIR_ENABLED: "1",
	});
	const hook = github<{ id: number }>(
		[
			matches[0]
				? `${repository}/hooks/${matches[0].id}`
				: `${repository}/hooks`,
			"--method",
			matches[0] ? "PATCH" : "POST",
			"--input",
			"-",
		],
		{
			name: "web",
			active: true,
			events: ["check_run", "check_suite", "pull_request_review"],
			config: {
				url: endpoint,
				content_type: "json",
				insecure_ssl: "0",
				secret,
			},
		},
	);
	console.info(
		JSON.stringify({
			developmentHookId: hook.id,
			endpoint,
			sharedAppHookChanged: false,
		}),
	);
}

await main();
