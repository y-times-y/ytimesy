import { Effect } from "effect";
import { sharedDesktopDeveloperInstructions } from "#/domain/agent-desktop";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { failureMessage } from "#/domain/failure-message";
import type { WorkspaceId } from "#/domain/ids";
import {
	type ProjectCheckout,
	projectCheckoutFromFullName,
	projectCheckoutPath,
} from "#/domain/project-checkout";
import {
	type Project,
	projectFolderName,
	repositoriesForProject,
} from "#/domain/projects";
import {
	sessionCloneBranch,
	sessionWorkingBranch,
} from "#/domain/session-branch";
import {
	checkoutWorkingBranchScript,
	cloneSelectedProjectScript,
	DEVELOPER_INSTRUCTIONS_PATH,
	fastForwardPreparedCheckoutScript,
	PROJECT_CONTEXT_PATH,
	PROJECT_CWD_PATH,
	PROJECT_TOKEN_PATH,
	preparedCheckoutPathFromReuse,
	redactInstallationToken,
	reusePreparedCheckoutCommand,
} from "#/server/adapters/freestyle/clone-project";
import { authorizedRepository } from "#/server/adapters/github";
import { githubInstallationAccessToken } from "#/server/adapters/github/installation-token";
import { ensureGuestCliPin } from "#/server/adapters/guest-cli-pin";
import { listProjects, projectForOwner } from "#/server/adapters/projects";
import { githubAccessToken } from "#/server/auth/github-connection";
import { startEnvironmentServices } from "./environment-services";
import { injectProjectSecrets } from "./project-secrets";
import type { DesktopScope } from "./workspace-desktop";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Reuses the sealed project checkout when the guest already has it.
 * Clones only when that directory is missing. A clean reused tree is
 * fast-forwarded to the project's branch; a dirty agent tree is not.
 * Guest exec cannot rewrite `/tmp/ytimesy-project-cwd` (permission denied);
 * the filesystem API can. Installation tokens are written to a temp file
 * on the VM and deleted during clone or fast-forward; they are never
 * stored in git remotes.
 */
export function ensureProjectCheckout(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	checkout: ProjectCheckout | null,
): Effect.Effect<string | null, Error> {
	return Effect.gen(function* () {
		for (const additional of checkout?.additionalRepositories ?? []) {
			yield* ensureSingleProjectCheckout(machines, workspaceId, additional);
		}
		return yield* ensureSingleProjectCheckout(machines, workspaceId, checkout);
	});
}

function ensureSingleProjectCheckout(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	checkout: ProjectCheckout | null,
): Effect.Effect<string | null, Error> {
	return Effect.gen(function* () {
		if (!checkout) {
			const home = yield* guestHome(machines, workspaceId);
			yield* writeDeveloperInstructions(machines, workspaceId, home);
			return null;
		}
		const reused = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				reusePreparedCheckoutCommand(checkout.name),
				15_000,
			),
		);
		const reusedPath = preparedCheckoutPathFromReuse(reused.stdout);
		if (reusedPath) {
			yield* Effect.tryPromise(() =>
				machines.writeTextFile(
					workspaceId,
					PROJECT_CWD_PATH,
					`${reusedPath}\n`,
				),
			);
			const token = yield* Effect.tryPromise(() =>
				githubInstallationAccessToken(checkout.installationId),
			).pipe(Effect.catchAll(() => Effect.succeed("")));
			if (token) {
				yield* Effect.tryPromise(() =>
					machines.writeTextFile(workspaceId, PROJECT_TOKEN_PATH, `${token}\n`),
				);
				yield* Effect.tryPromise(() =>
					machines.exec(
						workspaceId,
						fastForwardPreparedCheckoutScript({
							owner: checkout.owner,
							name: checkout.name,
							branch: checkout.branch,
							workingBranch: checkout.workingBranch,
							destination: reusedPath,
						}),
						60_000,
					),
				).pipe(
					Effect.catchAll(() =>
						Effect.tryPromise(() =>
							machines.exec(workspaceId, `rm -f ${PROJECT_TOKEN_PATH}`, 10_000),
						).pipe(Effect.catchAll(() => Effect.void)),
					),
				);
			} else if (checkout.workingBranch) {
				yield* Effect.tryPromise(() =>
					machines.exec(
						workspaceId,
						checkoutWorkingBranchScript(reusedPath, checkout.workingBranch),
						15_000,
					),
				).pipe(Effect.catchAll(() => Effect.void));
			}
			return reusedPath;
		}
		const home = yield* guestHome(machines, workspaceId);
		const destination = projectCheckoutPath(home, checkout.name);
		const token = yield* Effect.tryPromise(() =>
			githubInstallationAccessToken(checkout.installationId),
		);
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(workspaceId, PROJECT_TOKEN_PATH, `${token}\n`),
		);
		const cloned = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				cloneSelectedProjectScript({
					owner: checkout.owner,
					name: checkout.name,
					branch: checkout.branch,
					workingBranch: checkout.workingBranch,
					destination,
				}),
				180_000,
			),
		);
		if (cloned.exitCode !== 0) {
			yield* Effect.tryPromise(() =>
				machines.exec(workspaceId, `rm -f ${PROJECT_TOKEN_PATH}`, 10_000),
			).pipe(Effect.catchAll(() => Effect.void));
			throw new Error(
				`Could not clone ${checkout.fullName}: ${redactInstallationToken((cloned.stderr || cloned.stdout).trim() || "git clone failed.")}`,
			);
		}
		yield* writeDeveloperInstructions(machines, workspaceId, destination);
		return destination;
	}).pipe(Effect.mapError((cause) => new Error(failureMessage(cause))));
}

export function writeDeveloperInstructions(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	cwd: string,
	secretNames: readonly string[] = [],
	repositories: readonly string[] = [],
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.writeTextFile(
			workspaceId,
			DEVELOPER_INSTRUCTIONS_PATH,
			`${sharedDesktopDeveloperInstructions({ cwd, secretNames })} If ${PROJECT_CONTEXT_PATH} exists, treat it as this project's shared briefing and sibling traces. ${PREPARED_ENVIRONMENT_INSTRUCTIONS}\n${repositories.length > 1 ? `Project repositories (separate Git roots under the home directory): ${repositories.join(", ")}. Inspect each repository's instructions before editing it; commit and review each repository independently.\n` : ""}`,
		),
	).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Clone uses the signed-in owner's Postgres project.
 */
export function loadTenantProjectCheckout(scope: {
	readonly userId: string;
	readonly projectId?: string;
}): Effect.Effect<ProjectCheckout | null> {
	return Effect.tryPromise(async () => {
		const project = scope.projectId
			? await projectForOwner(scope.userId, scope.projectId)
			: ((await listProjects(scope.userId))[0] ?? null);
		if (!project) return null;
		const checkout = await checkoutForProject(scope.userId, project);
		if (!checkout) return null;
		const additionalRepositories = [];
		for (const repository of repositoriesForProject(project).slice(1)) {
			const additional = await checkoutForProject(scope.userId, {
				...repository,
				id: project.id,
			});
			if (additional) additionalRepositories.push(additional);
		}
		return { ...checkout, additionalRepositories };
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

async function checkoutForProject(userId: string, project: Project) {
	const defaultBranch = await projectDefaultBranch(userId, project);
	return projectCheckoutFromFullName({
		fullName: project.fullName,
		branch: sessionCloneBranch({
			selectedBranch: project.branch,
			defaultBranch,
			title: projectFolderName(project.fullName),
			id: String(project.repositoryId),
		}),
		workingBranch: sessionWorkingBranch({
			selectedBranch: project.branch,
			defaultBranch,
			title: projectFolderName(project.fullName),
			id: String(project.repositoryId),
		}),
		installationId: project.installationId,
	});
}

async function projectDefaultBranch(userId: string, project: Project) {
	try {
		const token = await githubAccessToken(userId);
		const repository = await authorizedRepository(
			token,
			project.installationId,
			project.repositoryId,
		);
		return repository.defaultBranch;
	} catch {
		return project.branch;
	}
}

export function preparePreparedGuest(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
	scope: DesktopScope,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		yield* ensureGuestCliPin(machines, workspaceId);
		const checkout = yield* loadTenantProjectCheckout(scope);
		const cwd = yield* ensureProjectCheckout(machines, workspaceId, checkout);
		const secretNames = yield* injectProjectSecrets(
			machines,
			workspaceId,
			scope,
		);
		yield* Effect.tryPromise(() =>
			startEnvironmentServices(machines, workspaceId),
		);
		yield* writeDeveloperInstructions(
			machines,
			workspaceId,
			cwd ?? "/home/ubuntu",
			secretNames,
			checkout
				? [checkout, ...(checkout.additionalRepositories ?? [])].map(
						(repo) => repo.fullName,
					)
				: [],
		);
	});
}

function guestHome(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<string> {
	return Effect.tryPromise(() =>
		machines.exec(workspaceId, `printf '%s' "\${HOME:-/home/ubuntu}"`, 15_000),
	).pipe(
		Effect.map((result) => {
			const home = result.stdout.trim();
			return home || "/home/ubuntu";
		}),
		Effect.catchAll(() => Effect.succeed("/home/ubuntu")),
	);
}
