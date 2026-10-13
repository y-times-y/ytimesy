import { createHash, randomUUID } from "node:crypto";
import {
	ENVIRONMENT_BUILD_RECOVERY_SECONDS,
	ENVIRONMENT_BUILD_TIMEOUT_SECONDS,
} from "#/domain/environment-build-limits";
import {
	type EnvironmentModel,
	environmentModel,
} from "#/domain/environment-model";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { EnvironmentRecipe } from "#/domain/project-environment";
import {
	ENVIRONMENT_RECIPE_PATH,
	environmentRecipe,
	parseEnvironmentRecipe,
} from "#/domain/project-environment";
import {
	type ProjectRepository,
	repositoriesForProject,
} from "#/domain/projects";
import { sessionCloneBranch } from "#/domain/session-branch";
import { toolsSnapshotIdFromEnv } from "#/domain/workspace-boot-snapshot";
import { captureServerAnalytics } from "../adapters/analytics";
import { database } from "../adapters/database";
import { DETACHED_COMMAND_ROOT } from "../adapters/freestyle/detached-command";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { authorizedRepository, repositoryBranchSha } from "../adapters/github";
import { loadProjectSecretsForOwner } from "../adapters/project-secrets";
import { projectForOwner } from "../adapters/projects";
import { guestNodePath, installArgv } from "../adapters/repository-setup";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	recordWorkspaceEvent,
	saveWorkspaceStatus,
	workspaceById,
} from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { readToolsSnapshotId } from "../records/tools-snapshot-store";
import { diagnoseEnvironmentFailure } from "./environment-diagnosis";
import { installWithEnvironmentRepair } from "./environment-repair";
import { prepareProjectCheckout } from "./prepare-project-checkout";
import { loadProjectSecretEnvironment } from "./project-secrets";
import { removeCodexCredentialsFromProjectTemplate } from "./project-template-credentials";

export type PreparedRepository = ProjectRepository & {
	commit: string;
	directory: string;
	recipe: EnvironmentRecipe;
	checkResults?: { command: string; exitCode: number }[];
};

export type EnvironmentBuildInput = {
	repairModel?: EnvironmentModel | null;
	workspaceId: string;
	userId: string;
	projectId: string;
	secretRevision: string;
	inputHash: string;
	baseSnapshotId: string | null;
	repositories: (ProjectRepository & { commit: string })[];
};

export async function resolveEnvironmentBuildInput(
	workspaceId: string,
	force: boolean,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
	repairModel: EnvironmentModel | null = null,
): Promise<EnvironmentBuildInput | null> {
	const workspace = await workspaceById(workspaceId);
	if (!workspace) throw new Error("Environment is unavailable.");
	const project = await projectForOwner(workspace.userId, workspace.projectId);
	if (!project) throw new Error("Project is unavailable.");
	const token = await githubAccessToken(workspace.userId);
	const repositories = [];
	for (const repo of repositoriesForProject(project)) {
		const authorized = await authorizedRepository(
			token,
			repo.installationId,
			repo.repositoryId,
		);
		const branch = sessionCloneBranch({
			selectedBranch: repo.branch,
			defaultBranch: authorized.defaultBranch,
			title: authorized.fullName.split("/").at(-1) || "project",
			id: String(repo.repositoryId),
		});
		const commit = await repositoryBranchSha(
			token,
			authorized.fullName,
			branch,
		);
		if (!commit) throw new Error("Cannot resolve the repository revision.");
		repositories.push({
			...repo,
			fullName: authorized.fullName,
			branch,
			commit,
		});
	}
	const baseSnapshotId =
		toolsSnapshotIdFromEnv(process.env) ||
		(await readToolsSnapshotId()) ||
		null;
	const secretRevision = await projectSecretRevision(
		workspace.userId,
		project.id,
	);
	const inputHash = createHash("sha256")
		.update(
			JSON.stringify({
				version: 3,
				repositories,
				baseSnapshotId,
				secretRevision,
			}),
		)
		.digest("hex");
	const previous = await database().query(
		"select input_hash from environment_build where workspace_id=$1 and status='ready' order by completed_at desc limit 1",
		[workspaceId],
	);
	if (
		!force &&
		workspace.templateSnapshotId &&
		previous.rows[0]?.input_hash === inputHash &&
		(await runtime.snapshotExists?.(workspace.templateSnapshotId))
	)
		return null;
	return {
		repairModel: repairModel ? environmentModel.parse(repairModel) : null,
		workspaceId,
		userId: workspace.userId,
		projectId: project.id,
		secretRevision,
		inputHash,
		baseSnapshotId,
		repositories,
	};
}

async function projectSecretRevision(userId: string, projectId: string) {
	const secrets = await loadProjectSecretsForOwner(userId, projectId);
	return createHash("sha256")
		.update(
			JSON.stringify(
				secrets.map(({ id, name, encrypted }) => ({ id, name, encrypted })),
			),
		)
		.digest("hex");
}

async function assertBuildSecretsCurrent(input: EnvironmentBuildInput) {
	if (
		(await projectSecretRevision(input.userId, input.projectId)) !==
		input.secretRevision
	)
		throw new Error(
			"Project secrets changed during setup. Retry the environment build.",
		);
}

export async function claimEnvironmentBuild(
	input: EnvironmentBuildInput,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	const abandoned = await database().query(
		"select id from environment_build where workspace_id=$1 and status='running' and created_at < now() - ($2 * interval '1 second')",
		[input.workspaceId, ENVIRONMENT_BUILD_RECOVERY_SECONDS],
	);
	for (const build of abandoned.rows)
		await finishEnvironmentBuild(input, build.id, runtime);
	const id = randomUUID();
	const claimed = await database().query(
		`insert into environment_build(id,workspace_id,status,input_hash,sources)
    values($1,$2,'running',$3,$4::jsonb) on conflict (workspace_id) where status='running' do nothing returning id`,
		[
			id,
			input.workspaceId,
			input.inputHash,
			JSON.stringify(input.repositories),
		],
	);
	if (!claimed.rows.length)
		throw new Error("An environment build is already running.");
	void captureServerAnalytics(
		input.userId,
		"environment_started",
		{
			repositories: input.repositories.length,
		},
		{ key: id, timestamp: new Date() },
	);
	return id;
}

export async function provisionEnvironmentBuild(
	input: EnvironmentBuildInput,
	id: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	const workspace = await workspaceById(input.workspaceId);
	const hasActive = Boolean(workspace?.templateSnapshotId);
	const event = (message: string) =>
		recordWorkspaceEvent(input.userId, input.workspaceId, message);
	if (!hasActive) await saveWorkspaceStatus(input.workspaceId, "provisioning");
	await event("Preparing project environment.");
	const providerRef = await runtime.provision(`ytimesy-build-${id}`, {
		...(input.baseSnapshotId ? { snapshotId: input.baseSnapshotId } : {}),
		maxRunSeconds: ENVIRONMENT_BUILD_TIMEOUT_SECONDS,
	});
	await database().query(
		"update environment_build set provider_ref=$2 where id=$1",
		[id, providerRef],
	);
	return providerRef;
}

export async function prepareEnvironmentRepositories(
	input: EnvironmentBuildInput,
	vm: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
): Promise<PreparedRepository[]> {
	const event = (message: string) =>
		recordWorkspaceEvent(input.userId, input.workspaceId, message);
	const host = {
		exec: (command: string, timeoutMs: number) =>
			runtime.exec(vm, ["bash", "-lc", command], {}, timeoutMs),
		writeTextFile: (path: string, contents: string) =>
			runtime.writeTextFile(vm, path, contents),
	};
	const homeResult = await host.exec(
		`printf '%s' "\${HOME:-/home/ubuntu}"`,
		15_000,
	);
	const home = homeResult.stdout.trim() || "/home/ubuntu";
	const prepared = [];
	for (const repo of input.repositories) {
		await updateInitialBuildStatus(input.workspaceId, "cloning");
		await event(`Preparing ${repo.fullName}.`);
		const [owner, name] = repo.fullName.split("/");
		const directory = await prepareProjectCheckout({
			userId: input.userId,
			projectId: input.projectId,
			host,
			owner,
			name,
			branch: repo.branch,
			workingBranch: repo.branch,
			installationId: repo.installationId,
			home,
			install: false,
			commit: repo.commit,
		});
		const recipeResult = await host.exec(
			`if [ -f ${quote(`${directory}/${ENVIRONMENT_RECIPE_PATH}`)} ]; then cat ${quote(`${directory}/${ENVIRONMENT_RECIPE_PATH}`)}; fi`,
			15_000,
		);
		if (recipeResult.exitCode !== 0)
			throw new Error("Could not read environment configuration.");
		let recipe = recipeResult.stdout.trim()
			? parseEnvironmentRecipe(recipeResult.stdout)
			: environmentRecipe.parse({});
		const listing = await host.exec(`ls -1 ${quote(directory)}`, 15_000);
		const files = listing.stdout.split("\n");
		if (!recipeResult.stdout.trim() && files.includes("package.json")) {
			const manifest = await host.exec(
				`cat ${quote(`${directory}/package.json`)}`,
				15_000,
			);
			const scripts = JSON.parse(manifest.stdout).scripts || {};
			const manager = files.includes("pnpm-lock.yaml")
				? "corepack pnpm"
				: files.includes("yarn.lock")
					? "corepack yarn"
					: "npm";
			const checks = ["typecheck", "build", "test"]
				.filter((name) => typeof scripts[name] === "string")
				.map((name) => `${manager} run ${name}`);
			recipe = environmentRecipe.parse({ checks });
		}
		if (!recipe.install && !files.includes("package.json"))
			throw new Error(
				`Add ${ENVIRONMENT_RECIPE_PATH} with install and verification commands for ${repo.fullName}.`,
			);
		await event(`Installing ${repo.fullName}.`);
		await updateInitialBuildStatus(input.workspaceId, "installing");
		const install = recipe.install
			? `cd ${quote(directory)} && ${guestNodePath()} && ${recipe.install}`
			: installArgv(directory, files)[2];
		await assertBuildSecretsCurrent(input);
		const secrets = await loadProjectSecretEnvironment(
			input.userId,
			input.projectId,
			recipe.buildSecrets,
		);
		try {
			await installWithEnvironmentRepair({
				runtime,
				vm,
				command: install,
				env: { ...secrets, CI: "true" },
				timeoutMs: recipe.timeoutSeconds * 1000,
				diagnose: (failure) =>
					diagnoseEnvironmentFailure({
						userId: input.userId,
						workspaceId: input.workspaceId,
						model: input.repairModel ?? null,
						vm,
						directory,
						failure,
						secrets,
					}),
				onRepair: (attempt) =>
					event(
						`Diagnosing dependency setup for ${repo.fullName} (repair ${attempt}/2).`,
					),
			});
		} catch (cause) {
			await event(
				`Dependency setup for ${repo.fullName} could not be completed automatically. Select a model and authorize repair, or check project secrets and the install command; no provider fallback was used.`,
			);
			throw cause;
		}
		prepared.push({ ...repo, directory, recipe });
	}
	assertDistinctEnvironmentServicePorts(prepared);
	return prepared;
}

export function assertDistinctEnvironmentServicePorts(
	repositories: PreparedRepository[],
) {
	const ports = repositories.flatMap((repo) =>
		repo.recipe.services.map((service) => service.port),
	);
	if (new Set(ports).size !== ports.length)
		throw new Error(
			"Repositories in one environment must use distinct service ports.",
		);
}

async function updateInitialBuildStatus(
	workspaceId: string,
	status: "cloning" | "installing",
) {
	await database().query(
		"update workspace set status=$2,updated_at=now() where id=$1 and template_snapshot_id is null",
		[workspaceId, status],
	);
}

export async function verifyEnvironmentRepositories(
	input: EnvironmentBuildInput,
	vm: string,
	repositories: PreparedRepository[],
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	const verified: PreparedRepository[] = [];
	for (const repo of repositories) {
		await assertBuildSecretsCurrent(input);
		const secrets = await loadProjectSecretEnvironment(
			input.userId,
			input.projectId,
			repo.recipe.buildSecrets,
		);
		await recordWorkspaceEvent(
			input.userId,
			input.workspaceId,
			`Verifying ${repo.fullName}.`,
		);
		for (const command of repo.recipe.verify) {
			const checked = await runtime.exec(
				vm,
				[
					"bash",
					"-lc",
					`cd ${quote(repo.directory)} && ${guestNodePath()} && ${command}`,
				],
				{ ...secrets, CI: "true" },
				repo.recipe.timeoutSeconds * 1000,
			);
			if (checked.exitCode !== 0)
				throw new Error(
					`Environment verification failed for ${repo.fullName}.`,
				);
		}
		const checkResults = [];
		for (const command of repo.recipe.checks) {
			const checked = await runtime.exec(
				vm,
				[
					"bash",
					"-lc",
					`cd ${quote(repo.directory)} && ${guestNodePath()} && ${command}`,
				],
				{ ...secrets, CI: "true" },
				Math.min(repo.recipe.timeoutSeconds, 120) * 1000,
			);
			checkResults.push({ command, exitCode: checked.exitCode });
			if (checked.exitCode !== 0)
				await recordWorkspaceEvent(
					input.userId,
					input.workspaceId,
					`${repo.fullName}: a baseline code check failed (exit ${checked.exitCode}). This does not block preparation; the task agent will receive this result.`,
				);
		}
		verified.push({ ...repo, checkResults });
	}
	return verified;
}

/** The previous snapshot stays active until all repositories pass verification. */
export async function activateEnvironmentBuild(
	input: EnvironmentBuildInput,
	id: string,
	vm: string,
	prepared: PreparedRepository[],
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	await assertBuildSecretsCurrent(input);
	// Chats start by switching the checkout to their own branch, which refuses
	// over uncommitted changes. Setup often rewrites tracked files (generated
	// code, lockfile drift); the template must start clean.
	for (const repo of prepared) {
		const reset = await runtime.exec(
			vm,
			[
				"bash",
				"-lc",
				`cd ${quote(repo.directory)} && git diff --name-only HEAD && git reset --hard --quiet HEAD`,
			],
			{},
			60_000,
		);
		const files = reset.stdout.split("\n").filter(Boolean);
		if (reset.exitCode !== 0)
			throw new Error(`Could not clean the ${repo.fullName} checkout.`);
		if (files.length)
			await recordWorkspaceEvent(
				input.userId,
				input.workspaceId,
				`${repo.fullName}: setup changed ${files.length} tracked ${files.length === 1 ? "file" : "files"} (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}); restored so chats start from a clean checkout.`,
			).catch(() => undefined);
	}
	await runtime.writeTextFile(
		vm,
		"/tmp/ytimesy-environment.json",
		JSON.stringify({ version: 1, repositories: prepared }),
	);
	await runtime.writeTextFile(
		vm,
		"/tmp/ytimesy-project-cwd",
		`${prepared[0].directory}\n`,
	);
	await removeCodexCredentialsFromProjectTemplate(runtime, vm);
	// Setup command logs may echo secrets; they must not reach the task template.
	await runtime.exec(vm, ["rm", "-rf", DETACHED_COMMAND_ROOT], {}, 15_000);
	const snapshotId = await runtime.snapshot(vm, `ytimesy-env-${id}`);
	const result = await database().query(
		`with activated as (
      update workspace set provider_ref=$2,template_snapshot_id=$3,status='ready',error_message=null,updated_at=now() where id=$1 and exists (select 1 from environment_build where id=$4 and workspace_id=$1 and status='running' and created_at > now() - ($5 * interval '1 second')) returning id
    ) update environment_build set status='ready',snapshot_id=$3,completed_at=now() where id=$4 and workspace_id in (select id from activated) returning id`,
		[input.workspaceId, vm, snapshotId, id, ENVIRONMENT_BUILD_RECOVERY_SECONDS],
	);
	if (!result.rows.length)
		throw new Error("Environment build is no longer active.");
	void captureServerAnalytics(
		input.userId,
		"environment_finished",
		{
			outcome: "ready",
		},
		{ key: id, timestamp: new Date() },
	);
	await recordWorkspaceEvent(
		input.userId,
		input.workspaceId,
		prepared.some((repo) =>
			repo.checkResults?.some((check) => check.exitCode !== 0),
		)
			? "Environment ready with baseline check failures recorded for the task agent."
			: "Environment verified and snapshot ready.",
	).catch(() => undefined);
	return snapshotId;
}

export async function finishEnvironmentBuild(
	input: Pick<EnvironmentBuildInput, "workspaceId" | "userId">,
	id: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	const result = await database().query(
		"select provider_ref,status from environment_build where id=$1 and workspace_id=$2",
		[id, input.workspaceId],
	);
	const build = result.rows[0];
	// Recover a provisioned resource even if saving its ID failed.
	const providerRef =
		build?.provider_ref ||
		(await runtime.findBySlug(`ytimesy-build-${id}`).catch(() => null));
	// Keep interrupted builds discoverable until pausing succeeds. A failed pause
	// must not turn a running build into a terminal row that recovery would skip.
	if (providerRef) await runtime.pause?.(providerRef);
	if (build?.status === "running") {
		const message =
			"Environment build did not complete. Check the repository setup commands and retry.";
		const failed = await database().query(
			"update environment_build set status='failed',error_message=$2,completed_at=now() where id=$1 and status='running' returning id",
			[id, message],
		);
		if (failed.rows.length)
			void captureServerAnalytics(
				input.userId,
				"environment_finished",
				{
					outcome: "failed",
				},
				{ key: id, timestamp: new Date() },
			);
		const workspace = await workspaceById(input.workspaceId);
		if (!workspace?.templateSnapshotId)
			await saveWorkspaceStatus(input.workspaceId, "failed", message);
		await recordWorkspaceEvent(input.userId, input.workspaceId, message);
	}
}

/** Recover interrupted setup independently of a new user request; never replace a ready template. */
export async function recoverExpiredEnvironmentBuilds(
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	const expired = await database().query<{
		id: string;
		workspace_id: string;
		user_id: string;
	}>(
		`select b.id,b.workspace_id,w.user_id from environment_build b
		 join workspace w on w.id=b.workspace_id where b.status='running'
		 and b.created_at < now()-($1 * interval '1 second')
		 order by b.created_at limit 16`,
		[ENVIRONMENT_BUILD_RECOVERY_SECONDS],
	);
	const recovered = await Promise.allSettled(
		expired.rows.map((row) =>
			finishEnvironmentBuild(
				{
					workspaceId: row.workspace_id,
					userId: row.user_id,
				},
				row.id,
				runtime,
			),
		),
	);
	return {
		recovered: recovered.filter((result) => result.status === "fulfilled")
			.length,
		failed: recovered.filter((result) => result.status === "rejected").length,
	};
}

/** Authorization/source failures happen before a build claim but must not leave setup queued. */
export async function failEnvironmentPreflight(workspaceId: string) {
	const message =
		"Could not start environment setup. Check repository access and the selected branches, then retry.";
	const failed = await database().query(
		`update workspace set status='failed',error_message=$2,updated_at=now()
		 where id=$1 and template_snapshot_id is null
		 and not exists(select 1 from environment_build where workspace_id=$1 and status='running')
		 returning user_id`,
		[workspaceId, message],
	);
	if (failed.rows[0])
		await recordWorkspaceEvent(failed.rows[0].user_id, workspaceId, message);
}
