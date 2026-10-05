import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { Freestyle } from "freestyle";
import { closeDatabase, database } from "#/server/adapters/database";
import { readFreestyleApiKey } from "#/server/adapters/freestyle/api-key";
import {
	JOB_WORKER_METADATA_PURPOSE,
	JOB_WORKER_SLUG,
} from "#/server/adapters/freestyle/job-worker-vm";
import { modelWorkflowSigningSecret } from "#/server/adapters/model-workflow-dispatch";

if (!process.argv.includes("--apply"))
	throw new Error("Explicit --apply is required.");
const development = "exampledevprojectref";
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (
	linked !== development ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(development)
)
	throw new Error("Not the approved development database.");
try {
	const active = await database().query(
		"select 1 from api_turn where state='running' limit 1",
	);
	if (active.rowCount)
		throw new Error("Finish active model turns before deploying.");
	const client = await database().connect();
	try {
		await client.query("begin");
		const version = "20261004010000";
		const existing = await client.query(
			"select 1 from supabase_migrations.schema_migrations where version=$1",
			[version],
		);
		if (!existing.rowCount) {
			const sql = await readFile(
				`supabase/migrations/${version}_model_workflow_steps.sql`,
				"utf8",
			);
			await client.query(sql);
			await client.query(
				"insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)",
				[version, "model_workflow_steps", [sql]],
			);
		}
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
} finally {
	await closeDatabase();
}

const freestyle = new Freestyle({
	apiKey: Effect.runSync(readFreestyleApiKey()),
});
const { vms } = await freestyle.vms.list({
	slug: JOB_WORKER_SLUG,
	metadata: `purpose:${JOB_WORKER_METADATA_PURPOSE}`,
	limit: 2,
});
if (vms.length !== 1)
	throw new Error(
		"Expected exactly one owned development worker; no VM will be created.",
	);
const hostname = `ytimesy-model-executor-${vms[0].id.replaceAll("-", "")}.style.dev`;
const rules = await freestyle.tls.rules.list({ vmId: vms[0].id });
const existing = rules.rules.find((rule) => rule.domain === hostname);
if (existing && existing.destination.port !== 8789)
	throw new Error("Executor route is bound to another port.");
if (!existing)
	await freestyle.tls.rules.create({
		action: "allow",
		domain: hostname,
		source: { public: true },
		destination: { vmId: vms[0].id, port: 8789 },
	});

function command(args: string[], input?: string, env = process.env) {
	const result = spawnSync("pnpm", args, {
		env,
		input,
		stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
	});
	if (result.status !== 0)
		throw new Error("Development workflow deployment command failed.");
}
const config = "wrangler.model-workflows.jsonc";
command([
	"exec",
	"wrangler",
	"deploy",
	"--config",
	config,
	"--var",
	`MODEL_EXECUTOR_URL:https://${hostname}`,
]);
command(
	[
		"exec",
		"wrangler",
		"secret",
		"put",
		"MODEL_WORKFLOW_SECRET",
		"--config",
		config,
	],
	modelWorkflowSigningSecret(),
);
command(["worker:vm"], undefined, {
	...process.env,
	YTIMESY_MODEL_EXECUTOR_ENABLED: "true",
	YTIMESY_MODEL_WORKFLOWS: process.argv.includes("--enable") ? "true" : "false",
	YTIMESY_MODEL_WORKFLOW_URL:
		"https://ytimesy-model-workflows-development.example-account.workers.dev/",
});
console.info(
	`Development executor staged at https://${hostname}. Workflow dispatch ${process.argv.includes("--enable") ? "enabled" : "not enabled"}.`,
);
