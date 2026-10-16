import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { environmentRecipe } from "../src/domain/project-environment";
import { MemoryWorkspaceRuntime } from "../src/server/adapters/workspace-runtime";
import {
	activateEnvironmentBuild,
	claimEnvironmentBuild,
	dependencyInputsChanged,
	type EnvironmentBuildInput,
	environmentInputHash,
	finishEnvironmentBuild,
	incrementalBase,
	provisionEnvironmentBuild,
	recoverExpiredEnvironmentBuilds,
	releaseFinishedBuildMachines,
	verifyEnvironmentRepositories,
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
const input: EnvironmentBuildInput = {
	workspaceId: "22222222-2222-4222-8222-222222222222",
	userId: "alice",
	projectId: "11111111-1111-4111-8111-111111111111",
	secretRevision: createHash("sha256").update("[]").digest("hex"),
	inputHash: "tested-input",
	baseSnapshotId: "tools-snapshot",
	repositories: [
		{
			repositoryId: 1,
			installationId: 1,
			fullName: "org/web",
			branch: "main",
			commit: "a".repeat(40),
		},
	],
};
const repositories = input.repositories.map((repo) => ({
	...repo,
	directory: "/home/ubuntu/web",
	recipe: environmentRecipe.parse({ verify: ["npm test"] }),
}));

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
	await db.exec(`alter table workspace add column template_snapshot_id text, add column template_source_ref text, add column template_source_sha text;
		insert into auth_user(id,name,email,"emailVerified") values ('alice','Alice','alice@test.invalid',true);
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('11111111-1111-4111-8111-111111111111','alice',1,1,'org/web','main');
		create table agent_session(id uuid primary key, provider_ref text);
		insert into workspace(id,user_id,project_id,status,template_snapshot_id,provider_ref) values('${input.workspaceId}','alice','11111111-1111-4111-8111-111111111111','ready','previous-snapshot','previous-machine');`);
});
afterAll(() => db.close());

it("keeps an interrupted build recoverable when pausing fails, then recovers it without a new request", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const id = await claimEnvironmentBuild(input, runtime);
	const vm = await provisionEnvironmentBuild(input, id, runtime);
	await db.query(
		"update environment_build set created_at=now()-interval '71 minutes' where id=$1",
		[id],
	);
	const pause = vi
		.spyOn(runtime, "pause")
		.mockRejectedValueOnce(new Error("provider unavailable"));
	expect(await recoverExpiredEnvironmentBuilds(runtime)).toEqual({
		recovered: 0,
		failed: 1,
	});
	expect(
		(
			await db.query<{ status: string }>(
				"select status from environment_build where id=$1",
				[id],
			)
		).rows[0].status,
	).toBe("running");
	expect(await recoverExpiredEnvironmentBuilds(runtime)).toEqual({
		recovered: 1,
		failed: 0,
	});
	expect(runtime.paused).toEqual([vm]);
	expect(pause).toHaveBeenCalledTimes(2);
	expect(await recoverExpiredEnvironmentBuilds(runtime)).toEqual({
		recovered: 0,
		failed: 0,
	});
});

it("preserves the last working snapshot when verification fails and pauses only the new builder", async () => {
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 1,
		stdout: "sensitive-output",
		stderr: "",
	});
	const id = await claimEnvironmentBuild(input);
	await expect(claimEnvironmentBuild(input)).rejects.toThrow("already running");
	const vm = await provisionEnvironmentBuild(input, id, runtime);
	await expect(
		verifyEnvironmentRepositories(input, vm, repositories, runtime),
	).rejects.toThrow("verification failed");
	await finishEnvironmentBuild(input, id, runtime);
	const workspace = await db.query<{
		template_snapshot_id: string;
		status: string;
	}>("select template_snapshot_id,status from workspace where id=$1", [
		input.workspaceId,
	]);
	expect(workspace.rows[0]).toEqual({
		template_snapshot_id: "previous-snapshot",
		status: "ready",
	});
	expect(runtime.paused).toEqual([vm]);
	const build = await db.query<{ status: string; error_message: string }>(
		"select status,error_message from environment_build where id=$1",
		[id],
	);
	expect(build.rows[0].status).toBe("failed");
	expect(build.rows[0].error_message).not.toContain("sensitive-output");
});

it("activates a verified replacement atomically and keeps it ready during cleanup", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const id = await claimEnvironmentBuild(input);
	const vm = await provisionEnvironmentBuild(input, id, runtime);
	await verifyEnvironmentRepositories(input, vm, repositories, runtime);
	const snapshot = await activateEnvironmentBuild(
		input,
		id,
		vm,
		repositories,
		runtime,
	);
	await finishEnvironmentBuild(input, id, runtime);
	const workspace = await db.query<{
		template_snapshot_id: string;
		provider_ref: string;
	}>("select template_snapshot_id,provider_ref from workspace where id=$1", [
		input.workspaceId,
	]);
	expect(workspace.rows[0]).toEqual({
		template_snapshot_id: snapshot,
		provider_ref: vm,
	});
	expect(runtime.paused).toEqual([vm]);
	const build = await db.query<{ status: string }>(
		"select status from environment_build where id=$1",
		[id],
	);
	expect(build.rows[0].status).toBe("ready");
});

it("reclaims only expired builds and pauses their builder before a retry", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const abandoned = await claimEnvironmentBuild(input, runtime);
	const vm = await provisionEnvironmentBuild(input, abandoned, runtime);
	await db.query(
		"update environment_build set created_at=now()-interval '71 minutes' where id=$1",
		[abandoned],
	);
	const retry = await claimEnvironmentBuild(input, runtime);
	expect(retry).not.toBe(abandoned);
	expect(runtime.paused).toEqual([vm]);
	await expect(claimEnvironmentBuild(input, runtime)).rejects.toThrow(
		"already running",
	);
	await finishEnvironmentBuild(input, retry, runtime);
});

it("does not activate a snapshot with a stale secret revision", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	await expect(
		activateEnvironmentBuild(
			{ ...input, secretRevision: "outdated" },
			"unused",
			"vm",
			repositories,
			runtime,
		),
	).rejects.toThrow("secrets changed");
	expect(runtime.snapshots.size).toBe(0);
});

it("records failed baseline checks without blocking activation or storing command output", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const exec = vi.spyOn(runtime, "exec");
	exec.mockResolvedValueOnce({
		exitCode: 2,
		stdout: "secret-output",
		stderr: "",
	});
	const checked = await verifyEnvironmentRepositories(
		input,
		"vm",
		[
			{
				...repositories[0],
				recipe: environmentRecipe.parse({ checks: ["npm run typecheck"] }),
			},
		],
		runtime,
	);
	expect(checked[0].checkResults).toEqual([
		{ command: "npm run typecheck", exitCode: 2 },
	]);
	expect(JSON.stringify(checked)).not.toContain("secret-output");
	const id = await claimEnvironmentBuild(input, runtime);
	const vm = await provisionEnvironmentBuild(input, id, runtime);
	const write = vi.spyOn(runtime, "writeTextFile");
	await activateEnvironmentBuild(input, id, vm, checked, runtime);
	expect(
		write.mock.calls.find(
			(call) => call[1] === "/tmp/ytimesy-environment.json",
		)?.[2],
	).toContain('"exitCode":2');
	await finishEnvironmentBuild(input, id, runtime);
});

it("permits installed projects without scripts but keeps infrastructure failures fatal", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	await expect(
		verifyEnvironmentRepositories(
			input,
			"vm",
			[{ ...repositories[0], recipe: environmentRecipe.parse({}) }],
			runtime,
		),
	).resolves.toHaveLength(1);
	vi.spyOn(runtime, "exec").mockRejectedValue(new Error("VM disconnected"));
	await expect(
		verifyEnvironmentRepositories(
			input,
			"vm",
			[
				{
					...repositories[0],
					recipe: environmentRecipe.parse({ checks: ["npm test"] }),
				},
			],
			runtime,
		),
	).rejects.toThrow("VM disconnected");
});

async function readyBuild(runtime: MemoryWorkspaceRuntime) {
	const id = await claimEnvironmentBuild(input, runtime);
	const vm = await provisionEnvironmentBuild(input, id, runtime);
	await activateEnvironmentBuild(input, id, vm, repositories, runtime);
	await finishEnvironmentBuild(input, id, runtime);
	return vm;
}

it("deletes a failed builder and the template it supersedes, but never the current template", async () => {
	await db.query(
		"update environment_build set provider_released_at=now() where provider_released_at is null",
	);
	const runtime = new MemoryWorkspaceRuntime();
	const first = await readyBuild(runtime);
	expect(runtime.deleted).toEqual([]);

	const failing = new MemoryWorkspaceRuntime({
		exitCode: 1,
		stdout: "",
		stderr: "",
	});
	const failedId = await claimEnvironmentBuild(input, failing);
	const failedVm = await provisionEnvironmentBuild(input, failedId, failing);
	await finishEnvironmentBuild(input, failedId, failing);
	expect(failing.deleted).toEqual([failedVm]);

	const second = await readyBuild(runtime);
	expect(runtime.deleted).toEqual([first]);
	expect(runtime.deleted).not.toContain(second);
	const workspace = await db.query<{ provider_ref: string }>(
		"select provider_ref from workspace where id=$1",
		[input.workspaceId],
	);
	expect(workspace.rows[0].provider_ref).toBe(second);
});

it("keeps a superseded template that a chat still runs on, and releases it once the chat moves", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const current = (
		await db.query<{ provider_ref: string }>(
			"select provider_ref from workspace where id=$1",
			[input.workspaceId],
		)
	).rows[0].provider_ref;
	await db.query(
		"insert into agent_session(id,provider_ref) values ('33333333-3333-4333-8333-333333333333',$1)",
		[current],
	);
	await readyBuild(runtime);
	expect(runtime.deleted).toEqual([]);
	await db.query("delete from agent_session");
	expect(
		await releaseFinishedBuildMachines(input.workspaceId, runtime),
	).toEqual({ released: 1, failed: 0 });
	expect(runtime.deleted).toEqual([current]);
	expect(
		await releaseFinishedBuildMachines(input.workspaceId, runtime),
	).toEqual({ released: 0, failed: 0 });
});

it("retries a release whose deletion failed", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const superseded = (
		await db.query<{ provider_ref: string }>(
			"select provider_ref from workspace where id=$1",
			[input.workspaceId],
		)
	).rows[0].provider_ref;
	const remove = vi
		.spyOn(runtime, "delete")
		.mockRejectedValueOnce(new Error("provider unavailable"));
	await readyBuild(runtime);
	expect(
		await releaseFinishedBuildMachines(input.workspaceId, runtime),
	).toEqual({ released: 1, failed: 0 });
	expect(remove).toHaveBeenLastCalledWith(superseded);
});

it("fast-forwards the template only when nothing but commits moved", () => {
	const repo = input.repositories[0];
	const priorSources = [{ ...repo, commit: "b".repeat(40) }];
	// The prior hash is recomputed from its jsonb sources (keys reordered).
	const reordered = priorSources.map((source) =>
		Object.fromEntries(Object.entries(source).reverse()),
	) as typeof priorSources;
	const exact = (sources: typeof priorSources) => ({
		input_hash: environmentInputHash(
			sources,
			input.baseSnapshotId,
			input.secretRevision,
		),
		sources: reordered,
	});
	expect(
		incrementalBase(
			exact(priorSources),
			input.repositories,
			input.baseSnapshotId,
			input.secretRevision,
			"template",
		),
	).toEqual({ snapshotId: "template", commits: { "1": "b".repeat(40) } });
	// A new base image, new secrets or another branch need a full build.
	for (const [base, secrets, repos] of [
		["new-tools", input.secretRevision, input.repositories],
		[input.baseSnapshotId, "rotated", input.repositories],
		[input.baseSnapshotId, input.secretRevision, [{ ...repo, branch: "next" }]],
	] as const)
		expect(
			incrementalBase(
				exact(priorSources),
				[...repos],
				base,
				secrets,
				"template",
			),
		).toBeNull();
});

it("reinstalls only when a manifest, lockfile, recipe or install input changed", () => {
	expect(dependencyInputsChanged(["src/app.ts", "README.md"], "")).toBe(false);
	for (const file of [
		"pnpm-lock.yaml",
		"packages/api/package.json",
		"services/ml/requirements-dev.txt",
		"go.sum",
		".ytimesy/environment.json",
	])
		expect(dependencyInputsChanged(["src/app.ts", file], ""), file).toBe(true);
	expect(
		dependencyInputsChanged(["scripts/setup.sh"], "bash scripts/setup.sh"),
	).toBe(true);
	// An unreadable diff is treated as changed.
	expect(dependencyInputsChanged(null, "")).toBe(true);
});

it("builds on the active template when the build is incremental", async () => {
	const runtime = new MemoryWorkspaceRuntime();
	const provision = vi.spyOn(runtime, "provision");
	await db.exec("delete from environment_build");
	const id = await claimEnvironmentBuild(input, runtime);
	await provisionEnvironmentBuild(
		{
			...input,
			incremental: { snapshotId: "previous-snapshot", commits: {} },
		},
		id,
		runtime,
	);
	expect(provision).toHaveBeenCalledWith(
		`ytimesy-build-${id}`,
		expect.objectContaining({ snapshotId: "previous-snapshot" }),
	);
	await db.exec("delete from environment_build");
});
