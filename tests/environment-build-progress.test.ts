import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EnvironmentCommandFailure } from "../src/domain/environment-build-progress";
import { environmentRecipe } from "../src/domain/project-environment";
import {
	activeEnvironmentSetup,
	databaseBuildSteps,
	environmentBuildProgress,
	latestEnvironmentBuild,
} from "../src/server/adapters/environment-build-steps";
import { MemoryWorkspaceRuntime } from "../src/server/adapters/workspace-runtime";
import { listReadyWorkspaceIds } from "../src/server/adapters/workspaces";
import {
	activateEnvironmentBuild,
	claimEnvironmentBuild,
	type EnvironmentBuildInput,
	finishEnvironmentBuild,
	type PreparedRepository,
	provisionEnvironmentBuild,
} from "../src/server/services/environment-build";

let db: PGlite;
vi.mock("../src/server/adapters/project-secrets", () => ({
	loadProjectSecretsForOwner: async () => [],
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: (sql: string, params: unknown[]) => db.query(sql, params),
	}),
}));

const workspaceId = "22222222-2222-4222-8222-222222222222";
const projectId = "11111111-1111-4111-8111-111111111111";
const input: EnvironmentBuildInput = {
	workspaceId,
	userId: "alice",
	projectId,
	secretRevision: createHash("sha256").update("[]").digest("hex"),
	inputHash: "tested-input",
	baseSnapshotId: "tools-snapshot",
	repositories: [
		{
			repositoryId: 1,
			installationId: 1,
			fullName: "org/tool",
			branch: "main",
			commit: "a".repeat(40),
		},
	],
};
const prepared = (setup: PreparedRepository["setup"]): PreparedRepository[] => [
	{
		...input.repositories[0],
		directory: "/home/ubuntu/tool",
		recipe: environmentRecipe.parse({}),
		setup,
	},
];

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913010000_enable_automatic_rls.sql",
		"20260913193000_identity_and_projects.sql",
		"20260913221500_workspaces_jobs_agent_accounts.sql",
		"20260927210000_project_environments.sql",
		"20261013101000_environment_build_release.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		"alter table workspace add column template_snapshot_id text, add column template_source_ref text, add column template_source_sha text;",
	);
	await db.exec(
		await readFile(
			"supabase/migrations/20261101150000_environment_build_progress.sql",
			"utf8",
		),
	);
	await db.exec(`insert into auth_user(id,name,email,"emailVerified") values ('alice','Alice','alice@test.invalid',true);
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('${projectId}','alice',1,1,'org/tool','main');
		create table agent_session(id uuid primary key, user_id text, project_id uuid, provider_ref text, updated_at timestamptz not null default now());
		insert into workspace(id,user_id,project_id,status) values('${workspaceId}','alice','${projectId}','queued');`);
});
afterAll(() => db.close());
beforeEach(async () => {
	await db.exec(`delete from environment_build; delete from agent_session;
		update workspace set status='queued',template_snapshot_id=null,provider_ref=null,error_message=null,plain_setup_requested=false;`);
});

it("records a failed first build's command, exit code and output, and fails the project with it", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const id = await claimEnvironmentBuild(input, runtime);
	await provisionEnvironmentBuild(input, id, runtime);
	const steps = databaseBuildSteps(id);
	await steps.start("install:1", "Installing dependencies", "cargo fetch");
	await steps.output("install:1", "Updating crates.io index");
	const failure = {
		step: "Installing dependencies",
		command: "cargo fetch",
		exitCode: 101,
		output: "error: failed to get `serde`",
	};
	await finishEnvironmentBuild(
		input,
		id,
		runtime,
		new EnvironmentCommandFailure(failure),
	);
	const workspace = await db.query<{ status: string; error_message: string }>(
		"select status,error_message from workspace where id=$1",
		[workspaceId],
	);
	expect(workspace.rows[0]).toEqual({
		status: "failed",
		error_message: "Installing dependencies: cargo fetch failed (exit 101)",
	});
	const progress = await environmentBuildProgress(workspaceId);
	expect(progress.build).toMatchObject({
		status: "failed",
		rebuild: false,
		failure,
	});
	expect(progress.steps.map((step) => [step.key, step.state])).toEqual([
		["machine", "done"],
		["install:1", "failed"],
	]);
	// The output read while it ran stays with the step.
	expect(progress.steps[1]?.output).toBe("Updating crates.io index");
});

it("keeps the generic message for failures that are not setup commands", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const id = await claimEnvironmentBuild(input, runtime);
	await finishEnvironmentBuild(
		input,
		id,
		runtime,
		new Error("provider said: secret=abc"),
	);
	const build = await latestEnvironmentBuild(workspaceId);
	expect(build?.errorMessage).toBe(
		"Environment build did not complete. Check the repository setup commands and retry.",
	);
	expect(build?.failure).toBeNull();
});

it("activates a plain checkout: records the setup, tells the agent, clears Send anyway", async () => {
	await db.query(
		"update workspace set plain_setup_requested=true where id=$1",
		[workspaceId],
	);
	const runtime = new MemoryWorkspaceRuntime();
	const write = vi.spyOn(runtime, "writeTextFile");
	const plainInput = { ...input, plain: true };
	const id = await claimEnvironmentBuild(plainInput, runtime);
	const vm = await provisionEnvironmentBuild(plainInput, id, runtime);
	const setup = {
		repositoryId: 1,
		fullName: "org/tool",
		source: "plain" as const,
	};
	await activateEnvironmentBuild(plainInput, id, vm, prepared(setup), runtime);
	const report = JSON.parse(
		write.mock.calls.find(
			(call) => call[1] === "/tmp/ytimesy-environment.json",
		)?.[2] ?? "{}",
	);
	expect(Object.keys(report)[1]).toBe("notice");
	expect(report.notice).toContain("Install what this task needs yourself");
	expect(await activeEnvironmentSetup(workspaceId)).toEqual([setup]);
	const workspace = await db.query<{
		status: string;
		plain_setup_requested: boolean;
	}>("select status,plain_setup_requested from workspace where id=$1", [
		workspaceId,
	]);
	expect(workspace.rows[0]).toEqual({
		status: "ready",
		plain_setup_requested: false,
	});
	const progress = await environmentBuildProgress(workspaceId);
	expect(progress.steps.at(-1)).toMatchObject({
		key: "ready",
		state: "done",
	});
});

it("marks a later build as a rebuild of the ready environment", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const first = await claimEnvironmentBuild(input, runtime);
	const vm = await provisionEnvironmentBuild(input, first, runtime);
	await activateEnvironmentBuild(
		input,
		first,
		vm,
		prepared({ repositoryId: 1, fullName: "org/tool", source: "saved" }),
		runtime,
	);
	await finishEnvironmentBuild(input, first, runtime);
	await claimEnvironmentBuild({ ...input, inputHash: "next" }, runtime);
	expect(await latestEnvironmentBuild(workspaceId)).toMatchObject({
		status: "running",
		rebuild: true,
	});
});

it("refreshes only workspaces with a chat active in the last week and no build running", async () => {
	await db.query(
		"update workspace set status='ready',template_snapshot_id='snap' where id=$1",
		[workspaceId],
	);
	expect(await listReadyWorkspaceIds()).toEqual([]);
	await db.query(
		"insert into agent_session(id,user_id,project_id,updated_at) values(gen_random_uuid(),'alice',$1,now()-interval '9 days')",
		[projectId],
	);
	expect(await listReadyWorkspaceIds()).toEqual([]);
	await db.query(
		"insert into agent_session(id,user_id,project_id,updated_at) values(gen_random_uuid(),'alice',$1,now()-interval '2 days')",
		[projectId],
	);
	expect(await listReadyWorkspaceIds()).toEqual([workspaceId]);
	await claimEnvironmentBuild(input);
	expect(await listReadyWorkspaceIds()).toEqual([]);
});
