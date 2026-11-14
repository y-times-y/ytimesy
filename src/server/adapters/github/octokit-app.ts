import { App, Octokit } from "octokit";
import {
	type GitHubRepository,
	gitHubRepositoryFromApi,
} from "#/domain/github-project";
import type { GitHubAppCredentials } from "./credentials";

type AuthorizedGitHubListing = {
	readonly installationCount: number;
	readonly repositories: readonly GitHubRepository[];
};

type GitHubAppListing = {
	readonly listAuthorized: (
		credentials: GitHubAppCredentials,
	) => Promise<AuthorizedGitHubListing>;
	readonly listBranches: (input: {
		credentials: GitHubAppCredentials;
		installationId: string;
		owner: string;
		name: string;
	}) => Promise<readonly string[]>;
	readonly installationToken: (input: {
		credentials: GitHubAppCredentials;
		installationId: string;
		repositoryNames?: string[];
		contents?: "read" | "write";
		pullRequests?: "read" | "write";
		checks?: "read";
		/** Actions workflow job logs (optional App permission). */
		actions?: "read";
	}) => Promise<string>;
};

export function createOctokitGitHubListing(): GitHubAppListing {
	return {
		async listAuthorized(credentials) {
			const app = githubApp(credentials);
			let installationCount = 0;
			const repositories: GitHubRepository[] = [];
			for await (const {
				octokit,
				installation,
			} of app.eachInstallation.iterator()) {
				installationCount += 1;
				const pages = await octokit.paginate("GET /installation/repositories", {
					per_page: 100,
				});
				for (const item of flattenInstallationRepositories(pages)) {
					const repository = gitHubRepositoryFromApi(
						String(installation.id),
						item,
					);
					if (repository) repositories.push(repository);
				}
			}
			return { installationCount, repositories };
		},
		async listBranches(input) {
			const app = githubApp(input.credentials);
			const octokit = await app.getInstallationOctokit(
				Number(input.installationId),
			);
			const pages = await octokit.paginate(
				"GET /repos/{owner}/{repo}/branches",
				{
					owner: input.owner,
					repo: input.name,
					per_page: 100,
				},
			);
			return flattenBranchNames(pages);
		},
		async installationToken(input) {
			const app = githubApp(input.credentials);
			const octokit = await app.getInstallationOctokit(
				Number(input.installationId),
			);
			const auth = await octokit.auth({
				type: "installation",
				...(input.repositoryNames
					? { repositoryNames: input.repositoryNames }
					: {}),
				...(input.contents ||
				input.pullRequests ||
				input.checks ||
				input.actions
					? {
							permissions: {
								...(input.actions ? { actions: input.actions } : {}),
								...(input.checks ? { checks: input.checks } : {}),
								...(input.contents ? { contents: input.contents } : {}),
								...(input.pullRequests
									? { pull_requests: input.pullRequests }
									: {}),
							},
						}
					: {}),
			});
			if (
				!auth ||
				typeof auth !== "object" ||
				typeof (auth as { token?: unknown }).token !== "string"
			) {
				throw new Error("GitHub App did not return an installation token");
			}
			return (auth as { token: string }).token;
		},
	};
}

export function flattenInstallationRepositories(pages: unknown): unknown[] {
	if (!Array.isArray(pages)) return [];
	return pages.flatMap((item) => {
		if (
			item &&
			typeof item === "object" &&
			Array.isArray((item as { repositories?: unknown }).repositories)
		) {
			return (item as { repositories: unknown[] }).repositories;
		}
		return [item];
	});
}

export function flattenBranchNames(pages: unknown): string[] {
	if (!Array.isArray(pages)) return [];
	return pages.flatMap((item) => {
		if (item && typeof item === "object" && "name" in item) {
			const name = (item as { name: unknown }).name;
			return typeof name === "string" && name.trim() ? [name.trim()] : [];
		}
		return [];
	});
}

/**
 * Octokit without its throttling plugin. On its first request that plugin
 * starts five Bottleneck groups, each with a 60 s cleanup interval that is
 * never cleared (unref() does nothing on Workers). In a Durable Object an
 * interval keeps the object awake: a pull request evidence job that minted a
 * token in 30 s held its BackgroundJobRunner awake for up to hours after it
 * returned (Nov 11-13). Transient failures and 429s are still retried by the
 * retry plugin; a 403 rate limit now fails instead of waiting in the object.
 */
const UnthrottledOctokit = Octokit.defaults({ throttle: { enabled: false } });

function githubApp(credentials: GitHubAppCredentials) {
	return new App({
		appId: credentials.appId,
		privateKey: credentials.privateKey,
		Octokit: UnthrottledOctokit,
	});
}
