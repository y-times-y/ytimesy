import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { RepositoryChoice } from "../../domain/projects";
import {
	descriptionKeepingEvidence,
	shouldReplacePullRequestBody,
} from "../../domain/pull-request-handoff";
import {
	checkState,
	githubUserName,
	type ListedRepositoryPullRequest,
	type PullRequestComment,
	type PullRequestDetail,
	pullRequestFileChange,
	pullRequestMergeFailure,
	pullRequestMergeMethod,
	pullRequestParticipants,
	pullRequestPerson,
} from "../../domain/pull-request-review";
import { pullRequestChecksSummary } from "../../domain/sidebar-chat-status";
import { serverConfig } from "../config";

const tokenResponse = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number().optional(),
});
interface GithubCredentials {
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
				private: repo.private,
			});
		}
	}
	return choices.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
export async function createAuthorizedRepository(
	token: string,
	name: string,
	/** False for an empty repository the caller pushes its own history into. */
	options: { readonly autoInit?: boolean } = {},
): Promise<RepositoryChoice> {
	const github = githubClient(token);
	let created: Awaited<
		ReturnType<typeof github.repos.createForAuthenticatedUser>
	>;
	try {
		created = await github.repos.createForAuthenticatedUser({
			name,
			private: true,
			auto_init: options.autoInit ?? true,
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
	// The repository belongs to the user's account, so only that account's
	// installation can grant access; an organization's installation never can.
	const owner = created.data.owner.login.toLowerCase();
	const installation = installations.find(
		(row) =>
			!row.suspended_at &&
			row.app_slug === serverConfig().GITHUB_APP_SLUG &&
			row.permissions.contents === "write" &&
			row.account !== null &&
			"login" in row.account &&
			row.account.login.toLowerCase() === owner,
	);
	if (!installation)
		throw new Response(
			`Created ${created.data.full_name}, but the ytimesy GitHub App is not installed on ${created.data.owner.login}. Install it there, then add the repository.`,
			{ status: 409 },
		);
	if (installation.repository_selection !== "all")
		try {
			await github.apps.addRepoToInstallationForAuthenticatedUser({
				installation_id: installation.id,
				repository_id: created.data.id,
			});
		} catch {
			throw new Response(
				`Created ${created.data.full_name}, but GitHub did not grant ytimesy access to it. Add it under Manage GitHub access, then add the repository.`,
				{ status: 409 },
			);
		}
	return {
		installationId: installation.id,
		repositoryId: created.data.id,
		fullName: created.data.full_name,
		defaultBranch: created.data.default_branch || "main",
	};
}

/**
 * Whether createAuthorizedRepository can succeed for this user: the ytimesy
 * app is installed on their own account with write access to contents.
 */
export async function githubRepositoryCreation(token: string) {
	const github = githubClient(token);
	const [user, installations] = await Promise.all([
		github.users.getAuthenticated(),
		github.paginate(github.apps.listInstallationsForAuthenticatedUser, {
			per_page: 100,
		}),
	]);
	const owner = user.data.login;
	const installed = installations.some(
		(row) =>
			!row.suspended_at &&
			row.app_slug === serverConfig().GITHUB_APP_SLUG &&
			row.permissions.contents === "write" &&
			row.account !== null &&
			"login" in row.account &&
			row.account.login.toLowerCase() === owner.toLowerCase(),
	);
	return { owner, canCreate: installed };
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
/** Pages of 100 a branch listing reads at most; search narrows the rest. */
const BRANCH_LIST_PAGES = 10;

export async function listBranches(
	token: string,
	repository: RepositoryChoice,
) {
	const [owner, repo] = repository.fullName.split("/");
	const github = githubClient(token);
	let pages = 0;
	let truncated = false;
	const names = await github.paginate(
		github.repos.listBranches,
		{ owner, repo, per_page: 100 },
		(response, done) => {
			pages += 1;
			if (pages >= BRANCH_LIST_PAGES) {
				truncated = response.data.length === 100;
				done();
			}
			return response.data.map((branch) => branch.name);
		},
	);
	return { names, truncated };
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

/**
 * A file's content at a commit, as `git show <commit>:<path>` prints it:
 * absent when the commit has no such path, null when GitHub cannot say (or
 * the path is not a regular file: a directory, symlink or submodule).
 */
export async function repositoryFileAtCommit(
	token: string,
	fullName: string,
	commit: string,
	path: string,
): Promise<{ present: false } | { present: true; text: string } | null> {
	if (!/^[a-f0-9]{40,64}$/.test(commit)) return null;
	const { owner, repo } = repositoryOwnerName(fullName);
	try {
		const { data } = await githubClient(token).repos.getContent({
			owner,
			repo,
			path,
			ref: commit,
		});
		// GitHub answers a symlink to a file with the target's content (and
		// path); git shows the link itself, so that is not this file.
		if (
			Array.isArray(data) ||
			data.type !== "file" ||
			data.path !== path ||
			!("encoding" in data) ||
			data.encoding !== "base64"
		)
			return null;
		return {
			present: true,
			text: Buffer.from(data.content, "base64").toString("utf8"),
		};
	} catch (error) {
		// Only GitHub's plain "Not Found" means the commit has no such path; a
		// missing commit or repository answers otherwise (or is unknown).
		const failure = error as {
			status?: unknown;
			response?: { data?: { message?: unknown } };
		};
		if (
			Number(failure?.status) === 404 &&
			failure.response?.data?.message === "Not Found"
		)
			return { present: false };
		return null;
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

/** GitHub's own validation text for a failed request, bounded; never a token. */
export function githubErrorText(error: unknown) {
	if (typeof error !== "object" || error === null) return "";
	const record = error as {
		message?: unknown;
		response?: { data?: { message?: unknown; errors?: unknown } };
	};
	const data = record.response?.data;
	const parts = [
		typeof data?.message === "string" ? data.message : undefined,
		...(Array.isArray(data?.errors)
			? data.errors.map((item: unknown) =>
					typeof item === "string"
						? item
						: typeof (item as { message?: unknown })?.message === "string"
							? (item as { message: string }).message
							: undefined,
				)
			: []),
		typeof record.message === "string" ? record.message : undefined,
	].filter((part): part is string => Boolean(part?.trim()));
	return [...new Set(parts)].join(" ").replace(/\s+/g, " ").slice(0, 300);
}

const DRAFTS_UNSUPPORTED = /draft pull requests? (?:are|is) not supported/i;

/**
 * Opens the pull request as a draft. Draft PRs need a paid plan on private
 * repositories, and GitHub answers those with a 422; that one case is retried
 * as a normal (ready) PR. Any other 422 says what GitHub said, so a refusal is
 * never reported as "already exists" unless GitHub said exactly that.
 */
async function createDraftPullRequest(
	token: string,
	fullName: string,
	draft: { title: string; body: string; head: string; base: string },
) {
	const { owner, repo } = repositoryOwnerName(fullName);
	const create = async (asDraft: boolean) => {
		const created = await githubClient(token).pulls.create({
			owner,
			repo,
			title: draft.title,
			body: draft.body,
			head: draft.head,
			base: draft.base,
			draft: asDraft,
		});
		return {
			number: created.data.number,
			url: created.data.html_url,
			draft: Boolean(created.data.draft),
		};
	};
	try {
		try {
			return await create(true);
		} catch (error) {
			if (
				githubStatus(error) === 422 &&
				DRAFTS_UNSUPPORTED.test(githubErrorText(error))
			)
				return await create(false);
			throw error;
		}
	} catch (error) {
		if (githubStatus(error) !== 422) throw error;
		const text = githubErrorText(error);
		if (/pull request already exists/i.test(text))
			throw new Response("A pull request for this branch already exists.", {
				status: 409,
			});
		if (/no commits between/i.test(text))
			throw new Response(
				"This branch has no commits ahead of the base branch, so there is nothing to open a pull request for.",
				{ status: 422 },
			);
		throw new Response(
			`GitHub refused to open the pull request${text ? `: ${text}` : "."}`,
			{ status: 422 },
		);
	}
}

function githubStatus(error: unknown) {
	return typeof error === "object" && error !== null && "status" in error
		? Number(error.status)
		: 0;
}

export async function ensureDraftPullRequest(
	token: string,
	fullName: string,
	draft: { title: string; body: string; head: string; base: string },
) {
	const { owner, repo } = repositoryOwnerName(fullName);
	const find = async () => {
		const result = await githubClient(token).pulls.list({
			owner,
			repo,
			state: "open",
			head: `${owner}:${draft.head}`,
			base: draft.base,
			per_page: 100,
		});
		const existing = result.data.find(
			(pull) =>
				pull.head.ref === draft.head &&
				pull.head.repo?.full_name === fullName &&
				pull.base.ref === draft.base,
		);
		return existing
			? {
					number: existing.number,
					url: existing.html_url,
					draft: Boolean(existing.draft),
					body: existing.body ?? "",
				}
			: null;
	};
	const reuse = async (found: {
		number: number;
		url: string;
		draft: boolean;
		body: string;
	}) => {
		await refreshPullRequestDescription(
			token,
			fullName,
			found,
			draft.body,
		).catch((error) => {
			console.warn("Pull request description could not be updated.", {
				message:
					error instanceof Error ? error.message.slice(0, 300) : "unknown",
			});
		});
		return { number: found.number, url: found.url, draft: found.draft };
	};
	const existing = await find();
	if (existing) return reuse(existing);
	try {
		return await createDraftPullRequest(token, fullName, draft);
	} catch (error) {
		if (error instanceof Response && error.status === 409) {
			const raced = await find();
			if (raced) return reuse(raced);
		}
		throw error;
	}
}

/** Replaces the description of an open pull request and keeps its evidence section. */
async function refreshPullRequestDescription(
	token: string,
	fullName: string,
	existing: { number: number; body: string },
	description: string,
) {
	if (!shouldReplacePullRequestBody(existing.body, description)) return;
	const body = descriptionKeepingEvidence(existing.body, description);
	if (body === existing.body) return;
	const { owner, repo } = repositoryOwnerName(fullName);
	await githubClient(token).pulls.update({
		owner,
		repo,
		pull_number: existing.number,
		body,
	});
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
		.filter(
			(pull) =>
				pull.head.ref.startsWith("ytimesy-") ||
				pull.head.ref.startsWith("ytimesy/"),
		)
		.slice(0, 30);
	return Promise.all(
		ours.map(async (pull) => {
			const full = await github.pulls.get({
				owner,
				repo,
				pull_number: pull.number,
			});
			// Only an open PR's checks show in the sidebar; finished ones skip the calls.
			const checks =
				full.data.state === "open"
					? pullRequestChecksSummary(
							(await headChecks(github, owner, repo, full.data.head.sha)).map(
								(check) => check.state,
							),
						)
					: null;
			return {
				number: full.data.number,
				url: full.data.html_url,
				head: full.data.head.ref,
				draft: Boolean(full.data.draft),
				state: full.data.state,
				merged: Boolean(full.data.merged),
				mergeable: full.data.mergeable ?? null,
				mergeableState: full.data.mergeable_state ?? null,
				checks,
			};
		}),
	);
}

/** The latest check runs and commit statuses on a commit; empty when GitHub refuses. */
async function headChecks(
	github: ReturnType<typeof githubClient>,
	owner: string,
	repo: string,
	ref: string,
) {
	const [runs, statuses] = await Promise.all([
		github.checks
			.listForRef({ owner, repo, ref, per_page: 100 })
			.then((response) => response.data.check_runs)
			.catch(() => []),
		github.repos
			.getCombinedStatusForRef({ owner, repo, ref })
			.then((response) => response.data.statuses)
			.catch(() => []),
	]);
	return [
		...runs.map((run) => ({
			name: run.name,
			state: checkState(run),
			url: run.html_url ?? null,
		})),
		...statuses.map((status) => ({
			name: status.context,
			state: checkState(status),
			url: status.target_url ?? null,
		})),
	];
}

/** Everything the in-app review panel shows for one ytimesy pull request. */
export async function pullRequestDetail(
	token: string,
	fullName: string,
	number: number,
): Promise<PullRequestDetail> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const [pull, files, reviews, comments, inline] = await Promise.all([
		github.pulls.get({ owner, repo, pull_number: number }),
		github.paginate(github.pulls.listFiles, {
			owner,
			repo,
			pull_number: number,
			per_page: 100,
		}),
		github.pulls.listReviews({
			owner,
			repo,
			pull_number: number,
			per_page: 100,
		}),
		github.issues.listComments({
			owner,
			repo,
			issue_number: number,
			per_page: 100,
		}),
		github.pulls.listReviewComments({
			owner,
			repo,
			pull_number: number,
			per_page: 100,
		}),
	]);
	const conversation: PullRequestComment[] = [
		...comments.data.map((comment) => ({
			id: `comment:${comment.id}`,
			kind: "comment" as const,
			author: pullRequestPerson(comment.user),
			body: comment.body ?? "",
			createdAt: comment.created_at,
			url: comment.html_url,
		})),
		...reviews.data
			.filter((review) => review.state !== "PENDING" && review.body?.trim())
			.map((review) => ({
				id: `review:${review.id}`,
				kind: "review" as const,
				author: pullRequestPerson(review.user),
				body: review.body ?? "",
				createdAt: review.submitted_at ?? pull.data.created_at,
				url: review.html_url,
				reviewState: review.state,
			})),
		...inline.data.map((comment) => ({
			id: `inline:${comment.id}`,
			kind: "inline" as const,
			author: pullRequestPerson(comment.user),
			body: comment.body,
			createdAt: comment.created_at,
			url: comment.html_url,
			path: comment.path,
			line: comment.line ?? comment.original_line ?? null,
			diffHunk: comment.diff_hunk.split("\n").slice(-8).join("\n"),
		})),
	].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const author = pullRequestPerson(pull.data.user);
	const checks = await headChecks(github, owner, repo, pull.data.head.sha);
	return {
		number: pull.data.number,
		title: pull.data.title,
		body: pull.data.body ?? "",
		url: pull.data.html_url,
		state: pull.data.merged
			? "merged"
			: pull.data.state === "closed"
				? "closed"
				: pull.data.draft
					? "draft"
					: "open",
		head: pull.data.head.ref,
		headSha: pull.data.head.sha,
		base: pull.data.base.ref,
		author: author.login,
		authorAvatarUrl: author.avatarUrl,
		createdAt: pull.data.created_at,
		updatedAt: pull.data.updated_at,
		mergeable: pull.data.mergeable ?? null,
		mergeableState: pull.data.mergeable_state ?? null,
		additions: pull.data.additions,
		deletions: pull.data.deletions,
		changedFiles: pull.data.changed_files,
		comments: pull.data.comments + pull.data.review_comments,
		checks,
		reviews: reviews.data
			.filter((review) => review.state !== "PENDING")
			.map((review) => ({
				author: review.user?.login ?? "",
				state: review.state,
				submittedAt: review.submitted_at ?? null,
			})),
		files: files.map(pullRequestFileChange),
		conversation,
		participants: pullRequestParticipants(author, conversation),
	};
}

/** Open pull requests in the repository, for reviewing any of them in-app. */
export async function listOpenPullRequests(
	token: string,
	fullName: string,
): Promise<ListedRepositoryPullRequest[]> {
	const { owner, repo } = repositoryOwnerName(fullName);
	const pulls = await githubClient(token).pulls.list({
		owner,
		repo,
		state: "open",
		per_page: 50,
	});
	return pulls.data.map((pull) => {
		const author = pullRequestPerson(pull.user);
		return {
			number: pull.number,
			title: pull.title,
			url: pull.html_url,
			author: author.login,
			authorName: githubUserName(pull.user),
			authorAvatarUrl: author.avatarUrl,
			draft: Boolean(pull.draft),
		};
	});
}

export async function markPullRequestReady(
	token: string,
	fullName: string,
	number: number,
) {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const pull = await github.pulls.get({ owner, repo, pull_number: number });
	if (!pull.data.draft) return;
	await github.graphql(
		"mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
		{ id: pull.data.node_id },
	);
}

/**
 * Merges only the head commit the user reviewed, with a method the repository
 * allows (squash when it can). GitHub's refusals become messages the user can act on.
 */
export async function mergePullRequest(
	token: string,
	fullName: string,
	number: number,
	expectedHeadSha: string,
) {
	const { owner, repo } = repositoryOwnerName(fullName);
	const github = githubClient(token);
	const settings = await github.repos.get({ owner, repo });
	const method = pullRequestMergeMethod(settings.data);
	if (!method)
		throw new Response(
			"This repository does not allow merging pull requests from the API. Merge it on GitHub.",
			{ status: 409 },
		);
	try {
		await github.pulls.merge({
			owner,
			repo,
			pull_number: number,
			merge_method: method,
			sha: expectedHeadSha,
		});
	} catch (error) {
		const message = pullRequestMergeFailure(error);
		if (message) throw new Response(message, { status: 409 });
		throw error;
	}
}
