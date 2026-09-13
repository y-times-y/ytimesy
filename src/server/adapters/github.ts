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
