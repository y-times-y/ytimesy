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
import { projectCheckoutPath } from "#/domain/project-checkout";
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
import { receiveBrokeredRepository } from "../adapters/github/git-broker";
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
	/**
	 * Rebuild on top of the active template instead of from the base image: only
	 * the repositories' commits changed since it was built. Maps repositoryId to
	 * the commit the template holds.
	 */
	incremental?: {
		readonly snapshotId: string;
		readonly commits: Readonly<Record<string, string>>;
	} | null;
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
	const inputHash = environmentInputHash(
		repositories,
		baseSnapshotId,
		secretRevision,
	);
	const previous = await database().query<{
		input_hash: string;
		sources: (ProjectRepository & { commit: string })[];
	}>(
		"select input_hash, sources from environment_build where workspace_id=$1 and status='ready' order by completed_at desc limit 1",
		[workspaceId],
	);
	const prior = previous.rows[0];
	const templateUsable =
		!force &&
		Boolean(workspace.templateSnapshotId) &&
		Boolean(prior) &&
		Boolean(
			workspace.templateSnapshotId &&
				(await runtime.snapshotExists?.(workspace.templateSnapshotId)),
		);
	if (templateUsable && prior?.input_hash === inputHash) return null;
	const incremental =
		templateUsable && prior && workspace.templateSnapshotId
			? incrementalBase(
					prior,
					repositories,
					baseSnapshotId,
					secretRevision,
					workspace.templateSnapshotId,
				)
			: null;
	return {
		incremental,
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

export function environmentInputHash(
	repositories: readonly (ProjectRepository & { commit: string })[],
	baseSnapshotId: string | null,
	secretRevision: string,
) {
	return createHash("sha256")
		.update(
			canonicalJson({
				version: 4,
				repositories,
				baseSnapshotId,
				secretRevision,
			}),
		)
		.digest("hex");
}

/** Key order independent: sources come back from jsonb with reordered keys. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

/**
 * The active template can be fast-forwarded when it was built from the same base
 * image, secrets and repositories/branches; only commits moved. Its recorded hash
 * proves the base image and secrets: recomputed from its own sources with today's
 * values, it must match.
 */
export function incrementalBase(
	prior: {
		readonly input_hash: string;
		readonly sources: readonly (ProjectRepository & { commit: string })[];
	},
	repositories: readonly (ProjectRepository & { commit: string })[],
	baseSnapshotId: string | null,
	secretRevision: string,
	snapshotId: string,
): EnvironmentBuildInput["incremental"] {
	if (
		environmentInputHash(prior.sources, baseSnapshotId, secretRevision) !==
		prior.input_hash
	)
		return null;
	const key = (repo: ProjectRepository) =>
		`${repo.repositoryId}:${repo.branch}`;
	const before = new Map(prior.sources.map((repo) => [key(repo), repo]));
	if (
		before.size !== repositories.length ||
		repositories.some((repo) => !before.has(key(repo)))
	)
		return null;
	return {
		snapshotId,
		commits: Object.fromEntries(
			repositories.map((repo) => [
				String(repo.repositoryId),
				before.get(key(repo))?.commit ?? "",
			]),
		),
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
	const from = input.incremental?.snapshotId ?? input.baseSnapshotId;
	const providerRef = await runtime.provision(`ytimesy-build-${id}`, {
		...(from ? { snapshotId: from } : {}),
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
		const previousCommit =
			input.incremental?.commits[String(repo.repositoryId)] ?? null;
		const reused = previousCommit
			? await fastForwardTemplateCheckout(host, {
					userId: input.userId,
					projectId: input.projectId,
					owner,
					name,
					branch: repo.branch,
					installationId: repo.installationId,
					directory: projectCheckoutPath(home, name),
					from: previousCommit,
					to: repo.commit,
				})
			: null;
		if (previousCommit && !reused)
			await event(
				`${repo.fullName} could not be fast-forwarded; preparing it from a fresh clone.`,
			);
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
		if (
			reused &&
			!dependencyInputsChanged(reused.changedFiles, recipe.install ?? "")
		) {
			await event(
				`${repo.fullName}: dependencies unchanged since the last environment; reusing them.`,
			);
			prepared.push({ ...repo, directory, recipe });
			continue;
		}
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
	await releaseFinishedBuildMachines(input.workspaceId, runtime);
}

/**
 * Deletes VMs of this workspace's finished builds (failed builders, superseded
 * templates) once no workspace or chat points at them. A failed deletion stays
 * unreleased and is retried when the next build finishes.
 */
export async function releaseFinishedBuildMachines(
	workspaceId: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
) {
	if (!runtime.delete) return { released: 0, failed: 0 };
	const { rows } = await database().query<{ id: string; provider_ref: string }>(
		`select b.id,b.provider_ref from environment_build b
		 where b.workspace_id=$1 and b.status in ('ready','failed')
		   and b.provider_ref is not null and b.provider_released_at is null
		   and not exists (select 1 from workspace w where w.provider_ref=b.provider_ref)
		   and not exists (select 1 from agent_session s where s.provider_ref=b.provider_ref)
		 order by b.created_at limit 16`,
		[workspaceId],
	);
	let released = 0;
	for (const row of rows)
		try {
			await runtime.delete(row.provider_ref);
			await database().query(
				"update environment_build set provider_released_at=now() where id=$1",
				[row.id],
			);
			released += 1;
		} catch {}
	return { released, failed: rows.length - released };
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

/** Files whose change means installed dependencies may be stale. */
const DEPENDENCY_FILES = new Set([
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	".npmrc",
	".nvmrc",
	".node-version",
	".tool-versions",
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"Pipfile",
	"Pipfile.lock",
	"setup.py",
	"setup.cfg",
	"Cargo.toml",
	"Cargo.lock",
	"rust-toolchain",
	"rust-toolchain.toml",
	"go.mod",
	"go.sum",
	"Gemfile",
	"Gemfile.lock",
	"composer.json",
	"composer.lock",
]);

/**
 * Whether a commit range touched anything install depends on: a manifest or
 * lockfile anywhere, the environment recipe, or a path the custom install
 * command names (e.g. scripts/setup.sh).
 */
export function dependencyInputsChanged(
	changedFiles: readonly string[] | null,
	installCommand: string,
) {
	if (!changedFiles) return true;
	return changedFiles.some((file) => {
		const base = file.split("/").at(-1) ?? file;
		return (
			DEPENDENCY_FILES.has(base) ||
			/^requirements.*\.txt$/.test(base) ||
			file === ENVIRONMENT_RECIPE_PATH ||
			file.startsWith(".ytimesy/") ||
			(installCommand.length > 0 && installCommand.includes(file))
		);
	});
}

/**
 * Moves the template's checkout to the build's commit without recloning.
 * Returns the files changed since the template, or null when the checkout is
 * missing, dirty, rewritten or lands elsewhere; the caller then reclones.
 */
async function fastForwardTemplateCheckout(
	host: {
		exec: (
			command: string,
			timeoutMs: number,
		) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
		writeTextFile: (path: string, contents: string) => Promise<void>;
	},
	input: {
		userId: string;
		projectId: string;
		owner: string;
		name: string;
		branch: string;
		installationId: number | string;
		directory: string;
		from: string;
		to: string;
	},
): Promise<{ changedFiles: string[] | null } | null> {
	const git = `git -C ${quote(input.directory)}`;
	try {
		const head = await host.exec(`${git} rev-parse HEAD`, 15_000);
		if (head.exitCode !== 0 || head.stdout.trim() !== input.from)
			throw new Error("Template checkout is not at its recorded commit.");
		const updated = await receiveBrokeredRepository(host, {
			userId: input.userId,
			projectId: input.projectId,
			owner: input.owner,
			name: input.name,
			branch: input.branch,
			workingBranch: input.branch,
			installationId: input.installationId,
			destination: input.directory,
			mode: "update",
		});
		if (updated !== "updated") throw new Error("Template checkout is dirty.");
		const moved = await host.exec(`${git} rev-parse HEAD`, 15_000);
		if (moved.stdout.trim() !== input.to)
			throw new Error("Template checkout did not reach the build commit.");
		const diff = await host.exec(
			`${git} diff --name-only ${quote(input.from)} ${quote(input.to)}`,
			30_000,
		);
		return {
			changedFiles:
				diff.exitCode === 0 ? diff.stdout.split("\n").filter(Boolean) : null,
		};
	} catch {
		await host.exec(`rm -rf ${quote(input.directory)}`, 120_000);
		return null;
	}
}
