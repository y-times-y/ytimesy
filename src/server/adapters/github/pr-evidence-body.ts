import { Octokit } from "@octokit/rest";
import { githubInstallationAccessToken } from "./installation-token";

type PullRequestBodyClient = {
	read(): Promise<{ body: string; headSha: string; state: string }>;
	write(body: string): Promise<void>;
};

function repositoryParts(fullName: string) {
	const [owner, repo, ...rest] = fullName.split("/");
	if (
		rest.length ||
		!owner ||
		!repo ||
		![owner, repo].every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
	)
		throw new Error("Invalid repository.");
	return { owner, repo };
}

/** The pull request's description and head, through the app's token for this repository only. */
export async function appPullRequestBody(
	installationId: number | string,
	fullName: string,
	pullNumber: number,
): Promise<PullRequestBodyClient> {
	const { owner, repo } = repositoryParts(fullName);
	if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
		throw new Error("Invalid pull request.");
	const token = await githubInstallationAccessToken(installationId, {
		repositoryNames: [repo],
		contents: "read",
		pullRequests: "write",
	});
	const github = new Octokit({ auth: token, request: { timeout: 15_000 } });
	return {
		async read() {
			const pull = (
				await github.rest.pulls.get({ owner, repo, pull_number: pullNumber })
			).data;
			return {
				body: pull.body ?? "",
				headSha: pull.head.sha,
				state: pull.state,
			};
		},
		async write(body) {
			await github.rest.pulls.update({
				owner,
				repo,
				pull_number: pullNumber,
				body,
			});
		},
	};
}

/** Numbers of the repository's open pull requests (evidence expiry), read-only token. */
export async function appOpenPullNumbers(
	installationId: number | string,
	fullName: string,
) {
	const { owner, repo } = repositoryParts(fullName);
	const token = await githubInstallationAccessToken(installationId, {
		repositoryNames: [repo],
		contents: "read",
		pullRequests: "read",
	});
	const github = new Octokit({ auth: token, request: { timeout: 15_000 } });
	const pulls = await github.paginate(github.rest.pulls.list, {
		owner,
		repo,
		state: "open",
		per_page: 100,
	});
	return new Set(pulls.map((pull) => pull.number));
}
