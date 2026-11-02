import { createHash, randomUUID } from "node:crypto";
import {
	dependencyCacheSpec,
	dependencyUploadsSettledCommand,
} from "#/domain/dependency-cache";
import {
	ENVIRONMENT_BUILD_RECOVERY_SECONDS,
	ENVIRONMENT_BUILD_TIMEOUT_SECONDS,
} from "#/domain/environment-build-limits";
import {
	buildOutputTail,
	EnvironmentCommandFailure,
	environmentFailureSummary,
} from "#/domain/environment-build-progress";
import {
	type DetectedEnvironment,
	detectEnvironment,
	type EnvironmentSetupSource,
	environmentSetupNotice,
	type RepositorySetup,
} from "#/domain/environment-detection";
import {
	type EnvironmentModel,
	environmentModel,
} from "#/domain/environment-model";
import { machineSize } from "#/domain/machine-size";
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
import { withCommandOutput } from "../adapters/command-output";
import { database } from "../adapters/database";
import {
	databaseBuildSteps,
	type EnvironmentBuildSteps,
	failRunningBuildSteps,
	noBuildSteps,
} from "../adapters/environment-build-steps";
import { latestEnvironmentRecipes } from "../adapters/environment-recipes";
import { DETACHED_COMMAND_ROOT } from "../adapters/freestyle/detached-command";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import { authorizedRepository, repositoryBranchSha } from "../adapters/github";
import { receiveBrokeredRepository } from "../adapters/github/git-broker";
import { projectMachineSize } from "../adapters/project-machine-size";
import { loadProjectSecretsForOwner } from "../adapters/project-secrets";
import { projectForOwner } from "../adapters/projects";
import { guestNodePath } from "../adapters/repository-setup";
import { ResumeLater } from "../adapters/resumable-commands";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	recordWorkspaceEvent,
	saveWorkspaceStatus,
	workspaceById,
} from "../adapters/workspaces";
import { githubAccessToken } from "../auth/github-connection";
import { readToolsSnapshotId } from "../records/tools-snapshot-store";
import {
	restoreDependencyCache,
	startDependencyCacheUpload,
} from "./dependency-cache";
import { diagnoseEnvironmentFailure } from "./environment-diagnosis";
import {
	releaseUntakenEnvironmentMachine,
	takeEarlyEnvironmentMachine,
} from "./environment-prestart";
import {
	EnvironmentInstallFailed,
	installWithEnvironmentRepair,
} from "./environment-repair";
import {
	type EnvironmentServiceResult,
	startRecipeServices,
	stopRecipeServices,
} from "./environment-services";
import { prepareProjectCheckout } from "./prepare-project-checkout";
import { loadProjectSecretEnvironment } from "./project-secrets";
import { removeCodexCredentialsFromProjectTemplate } from "./project-template-credentials";
import {
	SCRUB_VALUES_VARIABLE,
	scrubValues,
	templateCredentialScrub,
} from "./template-credential-scrub";

export type PreparedRepository = ProjectRepository & {
	commit: string;
	directory: string;
	recipe: EnvironmentRecipe;
	/** Where the recipe came from; left out by builds recorded before it existed. */
	setup?: RepositorySetup;
	checkResults?: { command: string; exitCode: number }[];
	/** Saved services started once during the build, then stopped. */
	serviceResults?: EnvironmentServiceResult[];
};

export type EnvironmentBuildInput = {
	repairModel?: EnvironmentModel | null;
	workspaceId: string;
	userId: string;
	projectId: string;
	secretRevision: string;
	inputHash: string;
	baseSnapshotId: string | null;
	repositories: (ProjectRepository & {
		commit: string;
		/** The setup saved in Settings > Project > Environment; it wins over the repo's file. */
		savedRecipe?: EnvironmentRecipe;
	})[];
	/** "Send anyway": clone only, no install or checks. */
	plain?: boolean;
	/**
	 * Rebuild on top of the active template instead of from the base image: only
	 * the repositories' commits changed since it was built. Maps repositoryId to
	 * the commit the template holds.
	 */
	incremental?: {
		readonly snapshotId: string;
		readonly commits: Readonly<Record<string, string>>;
		/**
		 * The template's saved setup per repositoryId (canonical JSON, "" for
		 * none): a different one now reinstalls even without new commits.
		 */
		readonly recipes?: Readonly<Record<string, string>>;
		/** Repositories whose detected install failed in the template: tried again. */
		readonly retryInstall?: readonly string[];
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
	const savedRecipes = await latestEnvironmentRecipes(
		workspace.userId,
		project.id,
	);
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
		// Unverified notes only explain the setup; they never change the image.
		const saved = withoutUnverified(
			savedRecipes.get(repo.repositoryId)?.recipe,
		);
		repositories.push({
			...repo,
			fullName: authorized.fullName,
			branch,
			commit,
			// Part of the input hash: a new saved setup rebuilds the image.
			...(saved ? { savedRecipe: saved } : {}),
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
	const plain = await plainSetupRequested(workspaceId);
	const inputHash = environmentInputHash(
		repositories,
		baseSnapshotId,
		secretRevision,
		plain,
	);
	const previous = await database().query<{
		input_hash: string;
		sources: (ProjectRepository & {
			commit: string;
			savedRecipe?: EnvironmentRecipe;
		})[];
		setup?: RepositorySetup[] | null;
	}>(
		"select input_hash, sources, setup from environment_build where workspace_id=$1 and status='ready' order by completed_at desc limit 1",
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
	// The same inputs already failed to rebuild: the hourly refresh does not
	// retry them every hour (Retry in Settings forces one).
	if (templateUsable && (await lastBuildFailedFor(workspaceId, inputHash)))
		return null;
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
		...(plain ? { plain: true } : {}),
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

async function plainSetupRequested(workspaceId: string) {
	const result = await database().query<{ plain_setup_requested?: boolean }>(
		"select plain_setup_requested from workspace where id=$1",
		[workspaceId],
	);
	return result.rows[0]?.plain_setup_requested === true;
}

async function lastBuildFailedFor(workspaceId: string, inputHash: string) {
	const result = await database().query<{
		status?: string;
		input_hash?: string;
	}>(
		"select status, input_hash from environment_build where workspace_id=$1 order by created_at desc limit 1",
		[workspaceId],
	);
	const last = result.rows[0];
	return last?.status === "failed" && last.input_hash === inputHash;
}

function withoutUnverified(recipe: EnvironmentRecipe | undefined) {
	if (!recipe) return undefined;
	const { unverified: _notes, ...built } = recipe;
	return built;
}

export function environmentInputHash(
	repositories: readonly (ProjectRepository & { commit: string })[],
	baseSnapshotId: string | null,
	secretRevision: string,
	plain = false,
) {
	return createHash("sha256")
		.update(
			canonicalJson({
				version: 4,
				repositories,
				baseSnapshotId,
				secretRevision,
				// Only when set, so earlier builds keep their hash.
				plain: plain || undefined,
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
		readonly sources: readonly (ProjectRepository & {
			commit: string;
			savedRecipe?: EnvironmentRecipe;
		})[];
		readonly setup?: readonly RepositorySetup[] | null;
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
		recipes: Object.fromEntries(
			repositories.map((repo) => [
				String(repo.repositoryId),
				recipeIdentity(before.get(key(repo))?.savedRecipe),
			]),
		),
		retryInstall: (prior.setup ?? [])
			.filter((setup) => setup.installFailure)
			.map((setup) => String(setup.repositoryId)),
	};
}

/** A saved setup's identity for "did it change since the template". */
function recipeIdentity(recipe: EnvironmentRecipe | undefined) {
	return recipe ? canonicalJson(recipe) : "";
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
	const steps = databaseBuildSteps(id);
	await steps.start("machine", "Starting machine");
	const from = input.incremental?.snapshotId ?? input.baseSnapshotId;
	// A first build takes the machine adding the project started; any other
	// boots its own.
	const early = await takeEarlyEnvironmentMachine(
		input,
		hasActive,
		runtime,
	).catch(() => null);
	const providerRef =
		early ??
		(await runtime
			.provision(`ytimesy-build-${id}`, {
				...(from ? { snapshotId: from } : {}),
				maxRunSeconds: ENVIRONMENT_BUILD_TIMEOUT_SECONDS,
			})
			.catch(async (cause: unknown) => {
				await steps.finish("machine", "failed");
				throw cause;
			}));
	await steps.finish(
		"machine",
		"done",
		early ? { note: "Started while the project was added" } : {},
	);
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
	steps: EnvironmentBuildSteps = noBuildSteps,
): Promise<PreparedRepository[]> {
	const event = (message: string) =>
		recordWorkspaceEvent(input.userId, input.workspaceId, message);
	const host = {
		exec: (command: string, timeoutMs: number) =>
			runtime.exec(vm, ["bash", "-lc", command], {}, timeoutMs),
		execWithEnv: (
			command: string,
			env: Record<string, string>,
			timeoutMs: number,
		) => runtime.exec(vm, ["bash", "-lc", command], env, timeoutMs),
		writeTextFile: (path: string, contents: string) =>
			runtime.writeTextFile(vm, path, contents),
	};
	const homeResult = await host.exec(
		`printf '%s' "\${HOME:-/home/ubuntu}"`,
		15_000,
	);
	const home = homeResult.stdout.trim() || "/home/ubuntu";
	const prepared: PreparedRepository[] = [];
	for (const repo of input.repositories) {
		const id = String(repo.repositoryId);
		await updateInitialBuildStatus(input.workspaceId, "cloning");
		await event(`Preparing ${repo.fullName}.`);
		const cloneStep = `clone:${id}`;
		await steps.start(cloneStep, `Cloning ${repo.fullName}`);
		const [owner, name] = repo.fullName.split("/");
		const previousCommit = input.incremental?.commits[id] ?? null;
		let reused: { changedFiles: string[] | null } | null = null;
		let directory: string;
		try {
			reused = previousCommit
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
			directory = await prepareProjectCheckout({
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
		} catch (cause) {
			if (!(cause instanceof ResumeLater))
				await steps.finish(cloneStep, "failed");
			throw cause;
		}
		await steps.finish(
			cloneStep,
			"done",
			reused ? { note: "Updated the existing checkout" } : {},
		);
		const detectStep = `detect:${id}`;
		await steps.start(detectStep, "Detecting the stack");
		const listing = await host.exec(`ls -1 ${quote(directory)}`, 15_000);
		const files = listing.stdout.split("\n").map((line) => line.trim());
		const chosen = await chooseRepositorySetup(input, repo, directory, files, {
			exec: host.exec,
			event,
		}).catch(async (cause: unknown) => {
			if (!(cause instanceof ResumeLater))
				await steps.finish(detectStep, "failed");
			throw cause;
		});
		const { recipe, source, detected } = chosen;
		await steps.finish(detectStep, source === "plain" ? "skipped" : "done", {
			note: detectedStackNote(source, detected),
		});
		const setup: RepositorySetup = {
			repositoryId: repo.repositoryId,
			fullName: repo.fullName,
			source,
			...(detected ? { detected: detected.label } : {}),
			...(chosen.install ? { install: chosen.install } : {}),
		};
		const installStep = `install:${id}`;
		if (!chosen.install) {
			await steps.start(installStep, "Installing dependencies");
			await steps.finish(installStep, "skipped", {
				note:
					source === "plain"
						? "Setup skipped"
						: source === "none"
							? "Nothing to install was detected"
							: "No install command",
			});
			prepared.push({ ...repo, directory, recipe, setup });
			continue;
		}
		const recipeChanged =
			(input.incremental?.recipes?.[id] ?? "") !==
			recipeIdentity(repo.savedRecipe);
		const retryInstall = input.incremental?.retryInstall?.includes(id);
		if (
			reused &&
			!recipeChanged &&
			!retryInstall &&
			!dependencyInputsChanged(reused.changedFiles, chosen.install)
		) {
			await event(
				`${repo.fullName}: dependencies unchanged since the last environment; reusing them.`,
			);
			await steps.start(installStep, "Installing dependencies", chosen.install);
			await steps.finish(installStep, "skipped", {
				note: "Dependencies unchanged",
			});
			prepared.push({ ...repo, directory, recipe, setup });
			continue;
		}
		await event(`Installing ${repo.fullName}.`);
		await updateInitialBuildStatus(input.workspaceId, "installing");
		await assertBuildSecretsCurrent(input);
		const secrets = await loadProjectSecretEnvironment(
			input.userId,
			input.projectId,
			recipe.buildSecrets,
		);
		const secretValues = Object.values(secrets);
		await steps.start(installStep, "Installing dependencies", chosen.install);
		// The same person's same lockfile on the same image installed before:
		// its archive is restored instead (a miss installs as usual).
		const cacheSpec = dependencyCacheSpec(files, chosen.install);
		const cached = cacheSpec
			? await restoreDependencyCache({
					host,
					directory,
					spec: cacheSpec,
					userId: input.userId,
					repositoryId: repo.repositoryId,
					install: chosen.install,
					baseSnapshotId: input.baseSnapshotId,
				}).catch(() => null)
			: null;
		if (cached?.restored && cacheSpec?.afterRestore === "skip") {
			await event(
				`${repo.fullName}: restored dependencies installed earlier from the same lockfile.`,
			);
			await steps.finish(installStep, "done", {
				note: "Restored from the dependency cache",
			});
			prepared.push({ ...repo, directory, recipe, setup });
			continue;
		}
		try {
			await withCommandOutput(
				(tail) =>
					steps.output(installStep, buildOutputTail(tail, secretValues)),
				() =>
					installWithEnvironmentRepair({
						runtime,
						vm,
						command: `cd ${quote(directory)} && ${guestNodePath()} && ${chosen.install}`,
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
					}),
			);
			await steps.finish(
				installStep,
				"done",
				cached?.restored ? { note: "Restored from the dependency cache" } : {},
			);
			// Stored in the background; activation waits for it before the snapshot.
			if (cacheSpec && cached && !cached.restored)
				await startDependencyCacheUpload({
					host,
					directory,
					spec: cacheSpec,
					key: cached.key,
				}).catch(() => false);
		} catch (cause) {
			if (cause instanceof ResumeLater) throw cause;
			const result =
				cause instanceof EnvironmentInstallFailed ? cause.result : null;
			const failure = {
				step: "Installing dependencies",
				command: chosen.install,
				exitCode: result?.exitCode ?? 1,
				output: result
					? buildOutputTail(`${result.stdout}\n${result.stderr}`, secretValues)
					: "",
			};
			await steps.finish(installStep, "failed", {
				exitCode: failure.exitCode,
				output: failure.output,
			});
			// A detected install is only a default: the project still gets a
			// machine with its checkout, and the agent is told it failed.
			if (source === "detected" && result) {
				await event(
					`${repo.fullName}: the detected install failed (exit ${failure.exitCode}); continuing without it.`,
				);
				prepared.push({
					...repo,
					directory,
					recipe,
					setup: { ...setup, installFailure: failure },
				});
				continue;
			}
			await event(
				`Dependency setup for ${repo.fullName} could not be completed automatically. Select a model and authorize repair, or check project secrets and the install command; no provider fallback was used.`,
			);
			throw result ? new EnvironmentCommandFailure(failure) : cause;
		}
		prepared.push({ ...repo, directory, recipe, setup });
	}
	assertDistinctEnvironmentServicePorts(prepared);
	return prepared;
}

/**
 * As Cursor does: the setup saved in ytimesy wins; without one, the
 * repository's own .ytimesy/environment.json is used as it is; without that,
 * a lockfile or manifest implies a default install. Nothing recognized is
 * not an error: the machine has the checkout and the agent installs.
 */
async function chooseRepositorySetup(
	input: Pick<EnvironmentBuildInput, "plain">,
	repo: EnvironmentBuildInput["repositories"][number],
	directory: string,
	files: readonly string[],
	host: {
		exec: (
			command: string,
			timeoutMs: number,
		) => Promise<{ exitCode: number; stdout: string }>;
		event: (message: string) => Promise<void>;
	},
): Promise<{
	recipe: EnvironmentRecipe;
	source: EnvironmentSetupSource;
	detected: DetectedEnvironment | null;
	install: string | undefined;
}> {
	if (input.plain)
		return {
			recipe: environmentRecipe.parse({}),
			source: "plain",
			detected: null,
			install: undefined,
		};
	// A saved or file setup without its own install keeps the lockfile install
	// for Node, as before.
	const nodeInstall = () =>
		files.includes("package.json")
			? detectEnvironment(files).install
			: undefined;
	if (repo.savedRecipe) {
		await host.event(`${repo.fullName}: using the saved environment setup.`);
		return {
			recipe: repo.savedRecipe,
			source: "saved",
			detected: null,
			install: repo.savedRecipe.install ?? nodeInstall(),
		};
	}
	const path = quote(`${directory}/${ENVIRONMENT_RECIPE_PATH}`);
	const recipeResult = await host.exec(
		`if [ -f ${path} ]; then cat ${path}; fi`,
		15_000,
	);
	if (recipeResult.exitCode !== 0)
		throw new Error("Could not read environment configuration.");
	const fileText = recipeResult.stdout.trim();
	if (fileText) {
		try {
			const recipe = parseEnvironmentRecipe(fileText);
			return {
				recipe,
				source: "file",
				detected: null,
				install: recipe.install ?? nodeInstall(),
			};
		} catch {
			await host.event(
				`${repo.fullName}: ${ENVIRONMENT_RECIPE_PATH} is not a valid setup; using the detected defaults.`,
			);
		}
	}
	let scripts: Record<string, unknown> = {};
	if (files.includes("package.json")) {
		const manifest = await host.exec(
			`cat ${quote(`${directory}/package.json`)}`,
			15_000,
		);
		try {
			scripts = JSON.parse(manifest.stdout).scripts || {};
		} catch {}
	}
	const detected = detectEnvironment(files, scripts);
	return {
		recipe: environmentRecipe.parse({
			...(detected.install ? { install: detected.install } : {}),
			checks: [...detected.checks],
		}),
		source: detected.label ? "detected" : "none",
		detected,
		install: detected.install,
	};
}

/** What the detect step says it found, in a few words. */
export function detectedStackNote(
	source: EnvironmentSetupSource,
	detected: Pick<DetectedEnvironment, "label"> | null,
) {
	if (source === "plain") return "Setup skipped";
	if (source === "saved") return "Saved setup";
	if (source === "file") return ENVIRONMENT_RECIPE_PATH;
	return detected?.label ?? "Nothing to install detected";
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
	steps: EnvironmentBuildSteps = noBuildSteps,
) {
	const verified: PreparedRepository[] = [];
	const step = "checks";
	const label = "Running checks";
	let started = false;
	let failedChecks = 0;
	for (const repo of repositories) {
		// A repository whose detected install failed has nothing to check yet.
		if (input.plain || repo.setup?.installFailure) {
			verified.push(repo);
			continue;
		}
		const commands = [...repo.recipe.verify, ...repo.recipe.checks];
		if (!commands.length && !repo.recipe.services.length) {
			verified.push(repo);
			continue;
		}
		await assertBuildSecretsCurrent(input);
		const secrets = await loadProjectSecretEnvironment(
			input.userId,
			input.projectId,
			repo.recipe.buildSecrets,
		);
		const secretValues = Object.values(secrets);
		await recordWorkspaceEvent(
			input.userId,
			input.workspaceId,
			`Verifying ${repo.fullName}.`,
		);
		const run = async (command: string, timeoutMs: number) => {
			await steps.start(step, label, command);
			started = true;
			return withCommandOutput(
				(tail) => steps.output(step, buildOutputTail(tail, secretValues)),
				() =>
					runtime.exec(
						vm,
						[
							"bash",
							"-lc",
							`cd ${quote(repo.directory)} && ${guestNodePath()} && ${command}`,
						],
						{ ...secrets, CI: "true" },
						timeoutMs,
					),
			);
		};
		for (const command of repo.recipe.verify) {
			const checked = await run(command, repo.recipe.timeoutSeconds * 1000);
			if (checked.exitCode !== 0) {
				const failure = {
					step: label,
					command,
					exitCode: checked.exitCode,
					output: buildOutputTail(
						`${checked.stdout}\n${checked.stderr}`,
						secretValues,
					),
				};
				await steps.finish(step, "failed", {
					exitCode: failure.exitCode,
					output: failure.output,
				});
				throw new EnvironmentCommandFailure(failure);
			}
		}
		const checkResults = [];
		for (const command of repo.recipe.checks) {
			const checked = await run(
				command,
				Math.min(repo.recipe.timeoutSeconds, 120) * 1000,
			);
			checkResults.push({ command, exitCode: checked.exitCode });
			if (checked.exitCode !== 0) failedChecks += 1;
			if (checked.exitCode !== 0)
				await recordWorkspaceEvent(
					input.userId,
					input.workspaceId,
					`${repo.fullName}: a baseline code check failed (exit ${checked.exitCode}). This does not block preparation; the task agent will receive this result.`,
				);
		}
		let serviceResults: EnvironmentServiceResult[] | undefined;
		if (repo.recipe.services.length) {
			await steps.start(step, label, `Starting ${repo.fullName} services`);
			started = true;
			// Services are checked once and stopped: chats start their own.
			const exec = async (command: string, timeoutMs: number) => {
				const result = await runtime.exec(
					vm,
					["bash", "-c", command],
					{ ...secrets, CI: "true" },
					timeoutMs,
				);
				return {
					...result,
					stdout: buildOutputTail(result.stdout, secretValues, 20),
				};
			};
			serviceResults = await startRecipeServices(exec, [repo]);
			await stopRecipeServices(exec, [repo]).catch(() => undefined);
			for (const service of serviceResults.filter((item) => !item.ready))
				await recordWorkspaceEvent(
					input.userId,
					input.workspaceId,
					`${repo.fullName}: service ${service.name} did not become ready on port ${service.port}. This does not block preparation.`,
				);
		}
		verified.push({
			...repo,
			checkResults,
			...(serviceResults ? { serviceResults } : {}),
		});
	}
	if (started)
		await steps.finish(
			step,
			"done",
			failedChecks
				? {
						note: `${failedChecks} baseline ${failedChecks === 1 ? "check" : "checks"} failed; the agent is told`,
					}
				: {},
		);
	else {
		await steps.start(step, label);
		await steps.finish(step, "skipped", {
			note: input.plain ? "Setup skipped" : "No checks saved",
		});
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
	const steps = databaseBuildSteps(id);
	await steps.start("ready", "Saving the environment");
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
	const setup = environmentSetupOf(input, prepared);
	const notice = environmentSetupNotice(setup);
	await runtime.writeTextFile(
		vm,
		"/tmp/ytimesy-environment.json",
		// The notice comes first: the agent's first read of the report sees it.
		JSON.stringify({
			version: 1,
			...(notice ? { notice } : {}),
			repositories: prepared,
		}),
	);
	await runtime.writeTextFile(
		vm,
		"/tmp/ytimesy-project-cwd",
		`${prepared[0].directory}\n`,
	);
	await removeCodexCredentialsFromProjectTemplate(runtime, vm);
	// Setup ran with build secrets: `npm login`, `docker login` and generated
	// .env files must not persist in the reusable template.
	const scrubbed = await runtime.exec(
		vm,
		[
			"bash",
			"-c",
			templateCredentialScrub({
				checkouts: prepared.map((repo) => repo.directory),
			}),
		],
		{
			[SCRUB_VALUES_VARIABLE]: scrubValues(
				await loadProjectSecretEnvironment(input.userId, input.projectId),
			),
		},
		60_000,
	);
	if (scrubbed.exitCode !== 0)
		throw new Error(
			"Could not remove credentials from the environment template.",
		);
	// A dependency upload still running must not be in the template: it
	// gets a little longer (it overlapped the checks), then is stopped.
	await runtime
		.exec(vm, ["bash", "-c", dependencyUploadsSettledCommand(25)], {}, 30_000)
		.catch(() => undefined);
	// Setup command logs may echo secrets; they must not reach the task template.
	await runtime.exec(vm, ["rm", "-rf", DETACHED_COMMAND_ROOT], {}, 15_000);
	// Chats copy this snapshot: it holds the project's disk size and a running
	// desktop, so a copy needs neither a disk grow nor a desktop start.
	const size = await projectMachineSize(input.userId, input.projectId).catch(
		() => null,
	);
	const snapshotId = await runtime.snapshot(vm, `ytimesy-env-${id}`, {
		storageMiB: size ? machineSize(size).storage : undefined,
		desktop: true,
	});
	const result = await database().query(
		`with activated as (
      update workspace set provider_ref=$2,template_snapshot_id=$3,status='ready',error_message=null,
        plain_setup_requested=(plain_setup_requested and not $7::boolean),updated_at=now()
      where id=$1 and exists (select 1 from environment_build where id=$4 and workspace_id=$1 and status='running' and created_at > now() - ($5 * interval '1 second')) returning id
    ) update environment_build set status='ready',snapshot_id=$3,completed_at=now(),setup=$6::jsonb where id=$4 and workspace_id in (select id from activated) returning id`,
		[
			input.workspaceId,
			vm,
			snapshotId,
			id,
			ENVIRONMENT_BUILD_RECOVERY_SECONDS,
			JSON.stringify(setup),
			Boolean(input.plain),
		],
	);
	if (!result.rows.length)
		throw new Error("Environment build is no longer active.");
	await steps.finish("ready", "done");
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

/** Each repository's setup as recorded; builds recorded before it say "file". */
function environmentSetupOf(
	input: Pick<EnvironmentBuildInput, "plain">,
	prepared: readonly PreparedRepository[],
): RepositorySetup[] {
	return prepared.map(
		(repo) =>
			repo.setup ?? {
				repositoryId: repo.repositoryId,
				fullName: repo.fullName,
				source: input.plain ? "plain" : "file",
			},
	);
}

/**
 * Ends a build that did not activate. A failed setup command is recorded as
 * it happened (command, exit code, output tail); anything else gets the
 * generic message, since provider and SQL errors are not for the person.
 */
export async function finishEnvironmentBuild(
	input: Pick<EnvironmentBuildInput, "workspaceId" | "userId">,
	id: string,
	runtime: WorkspaceRuntime = workspaceRuntimeFromEnv(),
	cause?: unknown,
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
		const failure =
			cause instanceof EnvironmentCommandFailure ? cause.failure : null;
		const message = failure
			? environmentFailureSummary(failure)
			: "Environment build did not complete. Check the repository setup commands and retry.";
		const failed = await database().query(
			"update environment_build set status='failed',error_message=$2,failure=$3::jsonb,completed_at=now() where id=$1 and status='running' returning id",
			[id, message, failure ? JSON.stringify(failure) : null],
		);
		await failRunningBuildSteps(id);
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
	if (failed.rows[0]) {
		await recordWorkspaceEvent(failed.rows[0].user_id, workspaceId, message);
		await releaseUntakenEnvironmentMachine(workspaceId).catch(() => undefined);
	}
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
