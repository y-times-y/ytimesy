import { Effect, Either } from "effect";
import {
	branchesForPicker,
	gitHubProjectCatalog,
	githubAppInstallUrl,
	type PublicProjectPicker,
	parseGitHubProjectId,
	publicProjectPicker,
	resolveSelectedBranch,
	resolveSelectedProject,
	type SelectedGitHubProject,
	selectionNeedsPersist,
} from "#/domain/github-project";
import { ProjectId } from "#/domain/ids";
import { readGitHubAppCredentials } from "#/server/adapters/github/credentials";
import {
	createOctokitGitHubListing,
	type GitHubAppListing,
} from "#/server/adapters/github/octokit-app";
import {
	clearSelectedProject,
	readSelectedProject,
	writeSelectedProject,
} from "#/server/records/selected-project-store";
import { GitHubAppRequestError } from "./errors";

export type GitHubProjectStore = {
	readonly read: () => Promise<SelectedGitHubProject | null>;
	readonly write: (selection: SelectedGitHubProject) => Promise<void>;
	readonly clear: () => Promise<void>;
};

export type GitHubProjectDeps = {
	readonly env?: NodeJS.ProcessEnv;
	readonly github: GitHubAppListing;
	readonly store: GitHubProjectStore;
};

export function liveGitHubProjectDeps(): GitHubProjectDeps {
	return {
		github: createOctokitGitHubListing(),
		store: {
			read: readSelectedProject,
			write: writeSelectedProject,
			clear: clearSelectedProject,
		},
	};
}

/** Tenant records are still local `.ytimesy/` proof state until Better Auth exists. */
export function loadGitHubProjectPicker(
	deps: GitHubProjectDeps,
): Effect.Effect<PublicProjectPicker> {
	return Effect.gen(function* () {
		const credentialsResult = yield* Effect.either(
			readGitHubAppCredentials(deps.env),
		);
		if (Either.isLeft(credentialsResult)) {
			return publicProjectPicker({
				catalog: gitHubProjectCatalog({
					credentialsPresent: false,
					installUrl: null,
					installationCount: 0,
					repositories: [],
				}),
				selected: null,
				branches: [],
			});
		}
		const credentials = credentialsResult.right;
		const installUrl = credentials.slug
			? githubAppInstallUrl(credentials.slug)
			: null;
		const listed = yield* Effect.either(
			Effect.tryPromise({
				try: () => deps.github.listAuthorized(credentials),
				catch: (cause) =>
					new GitHubAppRequestError({ message: githubErrorMessage(cause) }),
			}),
		);
		if (Either.isLeft(listed)) {
			return publicProjectPicker({
				catalog: gitHubProjectCatalog({
					credentialsPresent: true,
					installUrl,
					installationCount: 0,
					repositories: [],
					error: listed.left.message,
				}),
				selected: null,
				branches: [],
			});
		}
		const catalog = gitHubProjectCatalog({
			credentialsPresent: true,
			installUrl,
			installationCount: listed.right.installationCount,
			repositories: listed.right.repositories,
		});
		const saved = yield* readStoredSelection(deps.store);
		const projects = catalog.status === "ready" ? catalog.projects : [];
		const resolved = resolveSelectedProject({ projects, saved });
		if (selectionNeedsPersist(saved, resolved)) {
			yield* persistSelection(deps.store, resolved);
		}
		let selected = resolved;
		let branches: readonly string[] = [];
		if (selected && catalog.status === "ready") {
			const current = selected;
			const project = projects.find(
				(entry) => entry.projectId === current.projectId,
			);
			if (project) {
				const listedBranches = yield* Effect.either(
					Effect.tryPromise({
						try: () =>
							deps.github.listBranches({
								credentials,
								installationId: project.repository.installationId,
								owner: project.repository.owner,
								name: project.repository.name,
							}),
						catch: (cause) =>
							new GitHubAppRequestError({
								message: githubErrorMessage(cause),
							}),
					}),
				);
				if (Either.isRight(listedBranches)) {
					branches = branchesForPicker(
						listedBranches.right,
						project.repository.defaultBranch,
					);
					const branch = resolveSelectedBranch(
						current,
						branches,
						project.repository.defaultBranch,
					);
					if (branch !== current.branch) {
						selected = { projectId: current.projectId, branch };
						yield* persistSelection(deps.store, selected);
					}
				} else {
					branches = branchesForPicker([], project.repository.defaultBranch);
				}
			}
		}
		return publicProjectPicker({ catalog, selected, branches });
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed(
				publicProjectPicker({
					catalog: gitHubProjectCatalog({
						credentialsPresent: true,
						installUrl: null,
						installationCount: 0,
						repositories: [],
						error: githubErrorMessage(cause),
					}),
					selected: null,
					branches: [],
				}),
			),
		),
	);
}

export function saveGitHubProjectSelection(
	deps: GitHubProjectDeps,
	input: { projectId: string; branch: string },
) {
	return Effect.gen(function* () {
		const projectId = ProjectId(input.projectId);
		if (!parseGitHubProjectId(projectId)) {
			throw new Error("Select a GitHub repository.");
		}
		const branch = input.branch.trim();
		if (!branch) throw new Error("A branch is required.");
		const current = yield* loadGitHubProjectPicker(deps);
		const authorized = current.projects.some(
			(project) => project.projectId === projectId,
		);
		if (!authorized) {
			throw new Error("That repository is not granted to the GitHub App.");
		}
		yield* Effect.tryPromise({
			try: () => deps.store.write({ projectId, branch }),
			catch: (cause) =>
				new GitHubAppRequestError({ message: githubErrorMessage(cause) }),
		});
		return yield* loadGitHubProjectPicker(deps);
	});
}

function readStoredSelection(
	store: GitHubProjectStore,
): Effect.Effect<SelectedGitHubProject | null> {
	return Effect.tryPromise({
		try: () => store.read(),
		catch: (cause) =>
			new GitHubAppRequestError({ message: githubErrorMessage(cause) }),
	}).pipe(Effect.orElseSucceed(() => null));
}

function persistSelection(
	store: GitHubProjectStore,
	selection: SelectedGitHubProject | null,
): Effect.Effect<void> {
	return Effect.tryPromise({
		try: () => (selection ? store.write(selection) : store.clear()),
		catch: (cause) =>
			new GitHubAppRequestError({ message: githubErrorMessage(cause) }),
	}).pipe(Effect.catchAll(() => Effect.void));
}

function githubErrorMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message.trim()) {
		return cause.message.trim();
	}
	return "GitHub App request failed.";
}
