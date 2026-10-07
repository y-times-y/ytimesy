import { Effect } from "effect";
import { sharedDesktopDeveloperInstructions } from "#/domain/agent-desktop";
import { agentSessionRoleInstructions } from "#/domain/agent-orchestration";
import { PREPARED_ENVIRONMENT_INSTRUCTIONS } from "#/domain/environment-context";
import { failureMessage } from "#/domain/failure-message";
import type { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted } from "#/domain/posix-command";
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
import { sessionCloneBranch } from "#/domain/session-branch";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
import {
	DEVELOPER_INSTRUCTIONS_PATH,
	PROJECT_CONTEXT_PATH,
	PROJECT_CWD_PATH,
	preparedCheckoutPathFromReuse,
	reusePreparedCheckoutCommand,
} from "#/server/adapters/freestyle/clone-project";
import { authorizedRepository } from "#/server/adapters/github";
import { receiveBrokeredRepository } from "#/server/adapters/github/git-broker";
import { ensureGuestCliPin } from "#/server/adapters/guest-cli-pin";
import { listProjects, projectForOwner } from "#/server/adapters/projects";
import { githubAccessToken } from "#/server/auth/github-connection";
import { startEnvironmentServices } from "./environment-services";
import { injectProjectSecrets } from "./project-secrets";
import { establishVerificationBaselines } from "./verification-baseline";
import type { DesktopScope } from "./workspace-desktop";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Reuses the sealed project checkout when the guest already has it.
 * Clones only when that directory is missing. A clean reused tree is
 * fast-forwarded to the project's branch; a dirty agent tree is not.
 * Guest exec cannot rewrite `/tmp/ytimesy-project-cwd` (permission denied);
 * the filesystem API can. Authenticated fetches run on the server; the
 * guest receives Git bundles, never an installation token.
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
			const branch = yield* Effect.tryPromise(() =>
				machines.exec(
					workspaceId,
					`git -C ${posixShellQuoted(reusedPath)} branch --show-current`,
					15_000,
				),
			);
			const switching = branch.stdout.trim() !== checkout.workingBranch;
			if (
				checkout.retainExistingBranch ||
				(checkout.preserveCurrentBranch && !switching)
			)
				return reusedPath;
			yield* Effect.tryPromise(() =>
				receiveBrokeredRepository(
					{
						exec: (command, timeout) =>
							machines.exec(workspaceId, command, timeout),
						writeTextFile: (path, text) =>
							machines.writeTextFile(workspaceId, path, text),
					},
					{
						...checkout,
						destination: reusedPath,
						mode: switching ? "switch" : "update",
					},
				),
			).pipe(
				Effect.catchAll((error) =>
					switching
						? Effect.fail(
								error instanceof Error ? error : new Error(String(error)),
							)
						: Effect.void,
				),
			);
			return reusedPath;
		}
		const home = yield* guestHome(machines, workspaceId);
		const destination = projectCheckoutPath(home, checkout.name);
		yield* Effect.tryPromise(() =>
			receiveBrokeredRepository(
				{
					exec: (command, timeout) =>
						machines.exec(workspaceId, command, timeout),
					writeTextFile: (path, text) =>
						machines.writeTextFile(workspaceId, path, text),
				},
				{ ...checkout, destination, mode: "clone" },
			),
		);
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
	roleInstructions = "",
): Effect.Effect<void> {
	return Effect.tryPromise(() =>
		machines.writeTextFile(
			workspaceId,
			DEVELOPER_INSTRUCTIONS_PATH,
			`${sharedDesktopDeveloperInstructions({ cwd, secretNames })} If ${PROJECT_CONTEXT_PATH} exists, treat it as this project's shared briefing and sibling traces. ${PREPARED_ENVIRONMENT_INSTRUCTIONS}\n${repositories.length > 1 ? `Project repositories (separate Git roots under the home directory): ${repositories.join(", ")}. Inspect each repository's instructions before editing it; commit and review each repository independently.\n` : ""}${roleInstructions}\n`,
		),
	).pipe(Effect.catchAll(() => Effect.void));
}

/**
 * Clone uses the signed-in owner's Postgres project.
 */
export function loadTenantProjectCheckout(scope: {
	readonly userId: string;
	readonly projectId?: string;
	readonly sessionId?: string;
}): Effect.Effect<ProjectCheckout | null, Error> {
	return Effect.tryPromise(async () => {
		const project = scope.projectId
			? await projectForOwner(scope.userId, scope.projectId)
			: ((await listProjects(scope.userId))[0] ?? null);
		if (!project) return null;
		let session = scope.sessionId
			? await agentSessionForOwner(scope.userId, scope.sessionId)
			: null;
		if (session && session.projectId !== project.id)
			throw new Error("This chat is not in the selected project.");
		while (
			session?.parentSessionId &&
			!session.workingBranch &&
			session.taskExecution !== "stacked"
		) {
			session = await agentSessionForOwner(
				scope.userId,
				session.parentSessionId,
			);
			if (!session || session.projectId !== project.id)
				throw new Error("This task's parent is not available.");
		}
		const checkout = await checkoutForProject(
			scope.userId,
			session?.workingBranch
				? { ...project, branch: session.baseBranch ?? session.workingBranch }
				: project,
			session?.workingBranch,
		);
		if (!checkout) return null;
		const legacyConversation =
			Boolean(session) &&
			!session?.workingBranch &&
			sessionItemsFromUnknown(session?.items).some(
				(item) => item.kind === "userMessage",
			);
		const additionalRepositories = [];
		for (const repository of repositoriesForProject(project).slice(1)) {
			const additional = await checkoutForProject(scope.userId, {
				...repository,
				id: project.id,
			});
			if (additional) additionalRepositories.push(additional);
		}
		return {
			...checkout,
			retainExistingBranch: legacyConversation,
			additionalRepositories,
			preserveCurrentBranch:
				Boolean(session?.workingBranch) || legacyConversation,
		};
	}).pipe(Effect.mapError((error) => new Error(failureMessage(error))));
}

async function checkoutForProject(
	userId: string,
	project: Project,
	workingBranch?: string | null,
) {
	const defaultBranch = await projectDefaultBranch(userId, project);
	return projectCheckoutFromFullName({
		fullName: project.fullName,
		branch: sessionCloneBranch({
			selectedBranch: project.branch,
			defaultBranch,
			title: projectFolderName(project.fullName),
			id: String(project.repositoryId),
		}),
		workingBranch: workingBranch ?? project.branch,
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
		const session = scope.sessionId
			? yield* Effect.tryPromise(() =>
					agentSessionForOwner(scope.userId, scope.sessionId as string),
				)
			: null;
		if (
			cwd &&
			session &&
			session.taskAccess !== "read_only" &&
			session.taskPlacement !== "shared"
		)
			yield* Effect.tryPromise(() =>
				establishVerificationBaselines({
					machines,
					vm: workspaceId,
					cwd,
					userId: scope.userId,
					sessionId: session.id,
					additionalRepositoryNames: (
						checkout?.additionalRepositories ?? []
					).map((repo) => repo.name),
				}),
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
			agentSessionRoleInstructions(session ?? {}),
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
