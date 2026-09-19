import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { RepositoryChoice } from "../../domain/projects";
import { serverConfig } from "../config";

const tokenResponse = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number().optional(),
});
export interface GithubCredentials {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number | null;
}
export function githubClient(token: string) {
	return new Octokit({ auth: token, request: { timeout: 15000 } });
}
export async function exchangeGithubToken(
	parameters: Record<string, string>,
): Promise<GithubCredentials> {
	const config = serverConfig();
	const response = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: config.GITHUB_APP_CLIENT_ID,
			client_secret: config.GITHUB_APP_CLIENT_SECRET,
			...parameters,
		}),
		signal: AbortSignal.timeout(15000),
	});
	const token = tokenResponse.safeParse(await response.json());
	if (!response.ok || !token.success)
		throw new Error(
			"GitHub authorization expired or was rejected. Reconnect GitHub.",
		);
	return {
		accessToken: token.data.access_token,
		refreshToken: token.data.refresh_token,
		expiresAt: token.data.expires_in
			? Date.now() + token.data.expires_in * 1000
			: null,
	};
}
export async function listAuthorizedRepositories(
	token: string,
): Promise<RepositoryChoice[]> {
	const github = githubClient(token);
	const installations = await github.paginate(
		github.apps.listInstallationsForAuthenticatedUser,
		{ per_page: 100 },
	);
	const choices: RepositoryChoice[] = [];
	for (const installation of installations) {
		if (
			installation.suspended_at ||
			installation.permissions.contents !== "write" ||
			installation.app_slug !== serverConfig().GITHUB_APP_SLUG
		)
			continue;
		const repositories = await github.paginate(
			github.apps.listInstallationReposForAuthenticatedUser,
			{ installation_id: installation.id, per_page: 100 },
		);
		for (const repo of repositories) {
			if (repo.archived || repo.disabled || !repo.permissions?.push) continue;
			choices.push({
				installationId: installation.id,
				repositoryId: repo.id,
				fullName: repo.full_name,
				defaultBranch: repo.default_branch,
			});
		}
	}
	return choices.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
export async function createAuthorizedRepository(
	token: string,
	name: string,
): Promise<RepositoryChoice> {
	const github = githubClient(token);
	let created;
	try {
		created = await github.repos.createForAuthenticatedUser({
			name,
			private: true,
			auto_init: true,
		});
	} catch (error) {
		const status =
			typeof error === "object" && error !== null && "status" in error
				? Number(error.status)
				: 0;
		if (status === 422)
			throw new Response("That repository name is already used.", {
				status: 409,
			});
		if (status === 403)
			throw new Response(
				"GitHub denied creating a repository. Check the app permissions.",
				{ status: 409 },
			);
		throw error;
	}
	const installations = await github.paginate(
		github.apps.listInstallationsForAuthenticatedUser,
		{ per_page: 100 },
	);
	const installation = installations.find(
		(row) =>
			!row.suspended_at &&
			row.app_slug === serverConfig().GITHUB_APP_SLUG &&
			row.permissions.contents === "write",
	);
	if (!installation)
		throw new Response("Connect GitHub to create a repository.", {
			status: 409,
		});
	try {
		await github.apps.addRepoToInstallationForAuthenticatedUser({
			installation_id: installation.id,
			repository_id: created.data.id,
		});
	} catch {
		// All-repo installs already include the new repository.
	}
	return {
		installationId: installation.id,
		repositoryId: created.data.id,
		fullName: created.data.full_name,
		defaultBranch: created.data.default_branch || "main",
	};
}

export async function authorizedRepository(
	token: string,
	installationId: number,
	repositoryId: number,
) {
	const repositories = await listAuthorizedRepositories(token);
	const repository = repositories.find(
		(repo) =>
			repo.installationId === installationId &&
			repo.repositoryId === repositoryId,
	);
	if (!repository)
		throw new Response(
			"Repository access is unavailable. Refresh your GitHub connection.",
			{ status: 403 },
		);
	return repository;
}
export async function listBranches(
	token: string,
	repository: RepositoryChoice,
) {
	const [owner, repo] = repository.fullName.split("/");
	const github = githubClient(token);
	const branches = await github.paginate(github.repos.listBranches, {
		owner,
		repo,
		per_page: 100,
	});
	return branches.map((branch) => branch.name);
}

export async function repositoryBranchSha(
	token: string,
	fullName: string,
	ref: string,
) {
	const branch = ref.trim();
	if (!branch) return null;
	const { owner, repo } = repositoryOwnerName(fullName);
	try {
		const result = await githubClient(token).repos.getBranch({
			owner,
			repo,
			branch,
		});
		return result.data.commit.sha ?? null;
	} catch (error) {
		const status =
			typeof error === "object" && error !== null && "status" in error
				? Number(error.status)
				: 0;
		if (status === 404) return null;
		throw error;
	}
}

function repositoryOwnerName(fullName: string) {
	const [owner, repo] = fullName.split("/");
	if (!owner || !repo) throw new Error("Repository name is invalid.");
	return { owner, repo };
}

export async function compareBranchAhead(
	token: string,
	fullName: string,
	base: string,
	head: string,
) {
	const { owner, repo } = repositoryOwnerName(fullName);
	try {
		const comparison = await githubClient(token).repos.compareCommits({
			owner,
			repo,
			base,
			head,
		});
		return comparison.data.ahead_by ?? 0;
	} catch (error) {
		const status =
			typeof error === "object" && error !== null && "status" in error
				? Number(error.status)
				: 0;
		if (status === 404)
			throw new Response(
				"Branch is not on GitHub. Push it from the workspace first.",
				{ status: 409 },
			);
		throw error;
	}
}

export async function createDraftPullRequest(
	token: string,
	fullName: string,
	draft: { title: string; body: string; head: string; base: string },
) {
	const { owner, repo } = repositoryOwnerName(fullName);
	try {
		const created = await githubClient(token).pulls.create({
			owner,
			repo,
			title: draft.title,
			body: draft.body,
			head: draft.head,
			base: draft.base,
			draft: true,
		});
		return {
			number: created.data.number,
			url: created.data.html_url,
			draft: Boolean(created.data.draft),
		};
	} catch (error) {
		const status =
			typeof error === "object" && error !== null && "status" in error
				? Number(error.status)
				: 0;
		if (status === 422)
			throw new Response("A pull request for this branch already exists.", {
				status: 409,
			});
		throw error;
	}
}

export async function listSessionPullRequests(token: string, fullName: string) {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const pulls = await github.paginate(github.pulls.list, {
		owner,
		repo,
		state: "all",
		per_page: 100,
	});
	const ours = pulls
		.filter((pull) => pull.head.ref.startsWith("ytimesy-"))
		.slice(0, 30);
	return Promise.all(
		ours.map(async (pull) => {
			const full = await github.pulls.get({
				owner,
				repo,
				pull_number: pull.number,
			});
			return {
				number: full.data.number,
				url: full.data.html_url,
				head: full.data.head.ref,
				draft: Boolean(full.data.draft),
				state: full.data.state,
				merged: Boolean(full.data.merged),
				mergeable: full.data.mergeable ?? null,
				mergeableState: full.data.mergeable_state ?? null,
			};
		}),
	);
}
