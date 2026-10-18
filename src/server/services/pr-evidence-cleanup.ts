import { repositoriesForProject } from "#/domain/projects";
import { prEvidenceEvalUserIds } from "../adapters/dev-eval-users";
import {
	appEvidenceGitApi,
	deleteUserEvidenceRefs,
	type EvidenceGitApi,
	pruneEvidenceRefs,
} from "../adapters/github/pr-evidence-refs";
import { listProjects } from "../adapters/projects";
import {
	evidenceUserLabelFor,
	pullRequestEvidenceEnabled,
} from "./pr-evidence";

type Repository = {
	readonly fullName: string;
	readonly installationId: number | string;
};

type GitFor = (
	installationId: number | string,
	fullName: string,
) => Promise<EvidenceGitApi>;

const uniqueRepositories = (repositories: readonly Repository[]) => [
	...new Map(
		repositories.map((repo) => [repo.fullName.toLowerCase(), repo]),
	).values(),
];

/**
 * Removes a user's pull request evidence refs from the given repositories
 * (project or account deletion). Best effort: a repository the app can no
 * longer reach is reported, never thrown, so deletion itself proceeds.
 */
export async function removeUserPullRequestEvidence(
	userId: string,
	repositories: readonly Repository[],
	deps: {
		git?: GitFor;
		/** Skip users who never had evidence on (no GitHub calls for them). */
		enabled?: (userId: string) => Promise<boolean>;
	} = {},
) {
	const enabled = deps.enabled ?? ((id) => pullRequestEvidenceEnabled(id));
	if (!(await enabled(userId).catch(() => true)))
		return { removed: 0, failed: [] as string[] };
	const label = evidenceUserLabelFor(userId);
	let removed = 0;
	const failed: string[] = [];
	for (const repo of uniqueRepositories(repositories)) {
		try {
			const api = await (deps.git ?? appEvidenceGitApi)(
				repo.installationId,
				repo.fullName,
			);
			removed += await deleteUserEvidenceRefs(api, label);
		} catch {
			failed.push(repo.fullName);
		}
	}
	if (failed.length)
		console.warn("Pull request evidence refs were left in place.", {
			repositories: failed,
		});
	return { removed, failed };
}

/**
 * The periodic expiry sweep (maintenance action evidence-expiry): for every
 * user with evidence on, removes refs of pull requests that are no longer
 * open and captures past the retention period, even when no new capture runs
 * in that repository. Returns how many refs were removed.
 */
export async function expirePullRequestEvidence(
	deps: {
		users?: () => Promise<string[]>;
		repositories?: (userId: string) => Promise<readonly Repository[]>;
		git?: GitFor;
		now?: Date;
	} = {},
) {
	const users = await (deps.users ?? prEvidenceEvalUserIds)();
	const repositoriesOf =
		deps.repositories ??
		(async (userId: string) =>
			(await listProjects(userId)).flatMap((project) =>
				repositoriesForProject(project),
			));
	let removed = 0;
	for (const userId of users) {
		const label = evidenceUserLabelFor(userId);
		for (const repo of uniqueRepositories(await repositoriesOf(userId))) {
			try {
				const api = await (deps.git ?? appEvidenceGitApi)(
					repo.installationId,
					repo.fullName,
				);
				removed += (await pruneEvidenceRefs(api, label, { now: deps.now }))
					.length;
			} catch {
				console.warn("Pull request evidence expiry skipped a repository.", {
					repository: repo.fullName,
				});
			}
		}
	}
	return removed;
}
