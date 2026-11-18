import { Effect } from "effect";
import { failureMessage } from "#/domain/failure-message";
import { DIRTY_BRANCH_SWITCH_MESSAGE } from "#/domain/git-branch-switch";
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
import {
	agentSessionMetadataForOwner,
	sessionHoldsUserMessage,
} from "#/server/adapters/agent-sessions";
import {
	PROJECT_CWD_PATH,
	preparedCheckoutFromReuse,
	reusePreparedCheckoutCommand,
} from "#/server/adapters/freestyle/clone-project";
import {
	authorizedRepository,
	repositoryBranchSha,
	repositoryFileAtCommit,
} from "#/server/adapters/github";
import { receiveBrokeredRepository } from "#/server/adapters/github/git-broker";
import { githubInstallationAccessToken } from "#/server/adapters/github/installation-token";
import { listProjects, projectForOwner } from "#/server/adapters/projects";
import { githubAccessToken } from "#/server/auth/github-connection";
import type { WorkspaceMachines } from "./workspace-machines";

/** Effect wraps what a promise throws, so the message may sit a few causes down. */
function isDirtyBranchSwitch(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		if (current.message.includes(DIRTY_BRANCH_SWITCH_MESSAGE)) return true;
		current = current.cause;
	}
	return false;
}

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
			return null;
		}
		const reused = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				reusePreparedCheckoutCommand(checkout.name),
				15_000,
			),
		);
		const prepared = preparedCheckoutFromReuse(reused.stdout);
		if (prepared) {
			const reusedPath = prepared.path;
			// The reuse command already read the branch and the path note; a note
			// that already names this checkout is not written again. Whatever it
			// did not say takes its own round trip, as before.
			const [, branch] = yield* Effect.tryPromise(() =>
				Promise.all([
					prepared.cwdNote === reusedPath
						? undefined
						: machines.writeTextFile(
								workspaceId,
								PROJECT_CWD_PATH,
								`${reusedPath}\n`,
							),
					prepared.branch !== undefined
						? { stdout: prepared.branch }
						: machines.exec(
								workspaceId,
								`git -C ${posixShellQuoted(reusedPath)} branch --show-current`,
								15_000,
							),
				]),
			);
			const switching = branch.stdout.trim() !== checkout.workingBranch;
			// A pinned revision is always fetched: the checkout must land on it.
			if (
				!checkout.pinnedRevision &&
				(checkout.retainExistingBranch ||
					(checkout.preserveCurrentBranch && !switching))
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
				Effect.catchAll((error) => {
					// A checkout on another branch than the one on record, with work
					// of its own: switching would overwrite it. The chat's agent (or
					// the user) moved it there, so the turn goes on where it is.
					// A pinned revision must land exactly, so it still fails.
					if (
						switching &&
						!checkout.pinnedRevision &&
						isDirtyBranchSwitch(error)
					) {
						console.warn(
							"Kept the checkout's own branch: it has uncommitted changes.",
							{ recordedBranch: checkout.workingBranch },
						);
						return Effect.void;
					}
					return switching || checkout.pinnedRevision
						? Effect.fail(
								error instanceof Error ? error : new Error(String(error)),
							)
						: Effect.void;
				}),
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
		// As a reused checkout does: a machine booted without the project's
		// template (no build wrote it) finds its repository here. The primary
		// repository is cloned last, so its path is the one left.
		yield* Effect.tryPromise(() =>
			machines.writeTextFile(workspaceId, PROJECT_CWD_PATH, `${destination}\n`),
		);
		return destination;
	}).pipe(Effect.mapError((cause) => new Error(failureMessage(cause))));
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
		// Metadata only: the chat's items can be megabytes and this runs every
		// step. They are read below, and only for a chat with no working branch.
		let session = scope.sessionId
			? await agentSessionMetadataForOwner(scope.userId, scope.sessionId)
			: null;
		if (session && session.projectId !== project.id)
			throw new Error("This chat is not in the selected project.");
		while (session?.parentSessionId && !session.workingBranch) {
			session = await agentSessionMetadataForOwner(
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
			session !== null &&
			!session.workingBranch &&
			// Whether it holds a user message, answered in the database.
			(await sessionHoldsUserMessage(scope.userId, session.id));
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

/**
 * GitHub reads of a checkout before its VM is ready, sharing one read-only
 * installation token.
 */
export function checkoutGitHubReads(
	checkout: Pick<
		ProjectCheckout,
		"installationId" | "name" | "fullName" | "branch"
	>,
) {
	let token: Promise<string> | undefined;
	const readToken = () => {
		token ??= githubInstallationAccessToken(checkout.installationId, {
			repositoryNames: [checkout.name],
			contents: "read",
		});
		return token;
	};
	return {
		/**
		 * The commit a chat's new branch starts from: the head of the base
		 * branch the checkout fetches. Pinned on the checkout
		 * (pinnedRevision), it is also the chat's baseline.
		 */
		baseRevision: async (): Promise<string | null> => {
			const sha = await repositoryBranchSha(
				await readToken(),
				checkout.fullName,
				checkout.branch,
			);
			return sha && /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
		},
		/** A file of the checkout's repository at a commit; see repositoryFileAtCommit. */
		fileAt: async (revision: string, path: string) =>
			repositoryFileAtCommit(
				await readToken(),
				checkout.fullName,
				revision,
				path,
			),
	};
}

async function checkoutForProject(
	userId: string,
	project: Project,
	workingBranch?: string | null,
) {
	const defaultBranch = await projectDefaultBranch(userId, project);
	return projectCheckoutFromFullName({
		userId,
		projectId: project.id,
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
