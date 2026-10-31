import type { AgentProviderId } from "./agent-provider";
import type { FileChangeEntry } from "./session-item";

export type PullRequestCheck = {
	readonly name: string;
	readonly state: "passed" | "failed" | "pending" | "skipped";
	readonly url: string | null;
};

export type PullRequestReview = {
	readonly author: string;
	readonly state: string;
	readonly submittedAt: string | null;
};

export type PullRequestPerson = {
	readonly login: string;
	readonly avatarUrl: string | null;
	readonly bot: boolean;
};

/** One entry of the PR conversation: a comment, a review, or an inline code comment. */
export type PullRequestComment = {
	readonly id: string;
	readonly kind: "comment" | "review" | "inline";
	readonly author: PullRequestPerson;
	readonly body: string;
	readonly createdAt: string;
	readonly url: string | null;
	readonly reviewState?: string;
	readonly path?: string;
	readonly line?: number | null;
	readonly diffHunk?: string;
};

export type PullRequestDetail = {
	readonly number: number;
	readonly title: string;
	readonly body: string;
	readonly url: string;
	readonly state: "draft" | "open" | "merged" | "closed";
	readonly head: string;
	readonly headSha: string;
	readonly base: string;
	readonly author: string;
	readonly authorAvatarUrl: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly mergeable: boolean | null;
	readonly mergeableState: string | null;
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
	readonly comments: number;
	readonly checks: readonly PullRequestCheck[];
	readonly reviews: readonly PullRequestReview[];
	readonly files: readonly FileChangeEntry[];
	readonly conversation: readonly PullRequestComment[];
	readonly participants: readonly PullRequestPerson[];
};

export type ListedRepositoryPullRequest = {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	/** GitHub login. */
	readonly author: string;
	/** Profile name when the list payload includes one; otherwise null. */
	readonly authorName: string | null;
	readonly authorAvatarUrl: string | null;
	readonly draft: boolean;
};

type GithubUser = {
	login?: string;
	avatar_url?: string;
	name?: string | null;
	type?: string;
} | null;

/** Profile name from a GitHub user, when that payload includes one. */
export function githubUserName(user: GithubUser): string | null {
	const name = user?.name?.trim();
	return name ? name : null;
}

/** The person shown on a pull-request row: profile name when GitHub sent one, otherwise the login. */
export function listedPullRequestAuthor(pr: {
	readonly author: string;
	readonly authorName: string | null;
	readonly authorAvatarUrl: string | null;
}): PullRequestPerson & { readonly name: string } {
	const login = pr.author.trim() || "ghost";
	return {
		login,
		avatarUrl: pr.authorAvatarUrl,
		bot: login.endsWith("[bot]"),
		name: pr.authorName?.trim() || login.replace(/\[bot\]$/, ""),
	};
}

const GITHUB_PULL_URL =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+\/?$/;

/** `owner/repo` from a github.com pull request URL. */
export function githubPullFullName(url: string): string | null {
	return GITHUB_PULL_URL.exec(url.trim())?.[1] ?? null;
}

/** The first message of a review chat: which pull request, and to read the diff and comment. */
export function pullRequestReviewMessage(pull: {
	readonly fullName: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
}): string {
	const title = pull.title.replace(/\s+/g, " ").trim().slice(0, 200);
	return `Review pull request #${pull.number} "${title}" in ${pull.fullName} (${pull.url}). Read the diff and comment on issues.`;
}

/** What a review chat is started with. The open chat is not a field: the review does not continue it. */
export type PullRequestReviewStart = {
	readonly projectId: string;
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
	readonly requestId: string;
	readonly fullName: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
};

export function pullRequestReviewStart(input: {
	readonly projectId: string;
	readonly harnessId: AgentProviderId;
	readonly modelId: string;
	readonly requestId: string;
	readonly pull: {
		readonly fullName: string;
		readonly number: number;
		readonly title: string;
		readonly url: string;
	};
}): PullRequestReviewStart {
	return {
		projectId: input.projectId,
		harnessId: input.harnessId,
		modelId: input.modelId,
		requestId: input.requestId,
		fullName: input.pull.fullName,
		number: input.pull.number,
		title: input.pull.title,
		url: input.pull.url,
	};
}

/**
 * The chat a review opened. Refuses the chat that was already open: posting
 * the review there would run it inside that thread.
 */
export function pullRequestReviewSession(input: {
	readonly openedSessionId: string;
	readonly currentSessionId?: string;
}): { readonly sessionId: string } {
	if (
		input.currentSessionId &&
		input.openedSessionId === input.currentSessionId
	)
		throw new Error("A pull request review starts a new chat.");
	return { sessionId: input.openedSessionId };
}

/** Asks the server to open the review, then keeps only a session that is not the open chat. */
export async function startPullRequestReviewThread(input: {
	readonly currentSessionId?: string;
	readonly request: PullRequestReviewStart;
	readonly start: (
		request: PullRequestReviewStart,
	) => Promise<{ readonly sessionId: string }>;
}): Promise<string> {
	const chat = await input.start(input.request);
	return pullRequestReviewSession({
		openedSessionId: chat.sessionId,
		currentSessionId: input.currentSessionId,
	}).sessionId;
}

export function pullRequestPerson(user: GithubUser): PullRequestPerson {
	const login = user?.login ?? "ghost";
	return {
		login,
		avatarUrl: user?.avatar_url ?? null,
		bot: user?.type === "Bot" || login.endsWith("[bot]"),
	};
}

/** Everyone who wrote in the conversation, author first, each once. */
export function pullRequestParticipants(
	author: PullRequestPerson,
	conversation: readonly PullRequestComment[],
): PullRequestPerson[] {
	const people = new Map<string, PullRequestPerson>([[author.login, author]]);
	for (const entry of conversation)
		if (!people.has(entry.author.login))
			people.set(entry.author.login, entry.author);
	return [...people.values()];
}

/** GitHub's per-file patch is hunks only; give it file headers so it parses as a unified diff. */
export function pullRequestFileChange(file: {
	filename: string;
	previous_filename?: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
}): FileChangeEntry {
	const change =
		file.status === "added"
			? "add"
			: file.status === "removed"
				? "delete"
				: "update";
	const before =
		change === "add"
			? "/dev/null"
			: `a/${file.previous_filename ?? file.filename}`;
	const after = change === "delete" ? "/dev/null" : `b/${file.filename}`;
	return {
		path: file.filename,
		change,
		additions: file.additions,
		deletions: file.deletions,
		preview: file.patch ? `--- ${before}\n+++ ${after}\n${file.patch}\n` : null,
	};
}

/** One summary state per check run or commit status. */
export function checkState(input: {
	status?: string | null;
	conclusion?: string | null;
	state?: string | null;
}): PullRequestCheck["state"] {
	const value = (
		input.conclusion ??
		input.state ??
		input.status ??
		""
	).toLowerCase();
	if (["success"].includes(value)) return "passed";
	if (
		[
			"failure",
			"error",
			"timed_out",
			"cancelled",
			"action_required",
			"startup_failure",
		].includes(value)
	)
		return "failed";
	if (["skipped", "neutral", "stale"].includes(value)) return "skipped";
	return "pending";
}

export type PullRequestMergeMethod = "squash" | "merge" | "rebase";

/** The repository's allowed merge method, preferring squash. GitHub omits the
 * flags for tokens without admin access; missing means allowed (its defaults). */
export function pullRequestMergeMethod(repository: {
	allow_squash_merge?: boolean;
	allow_merge_commit?: boolean;
	allow_rebase_merge?: boolean;
}): PullRequestMergeMethod | null {
	if (repository.allow_squash_merge !== false) return "squash";
	if (repository.allow_merge_commit !== false) return "merge";
	if (repository.allow_rebase_merge !== false) return "rebase";
	return null;
}

/** A message for GitHub's merge refusals, or null for failures that are not the user's to fix. */
export function pullRequestMergeFailure(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("status" in error))
		return null;
	const status = Number(error.status);
	const detail =
		"message" in error && typeof error.message === "string"
			? error.message.split(" - http")[0].trim()
			: "";
	if (status === 409)
		return "The pull request changed since you reviewed it. Review the latest commits, then merge again.";
	if (status === 405)
		return /protect|required|review|status check/i.test(detail)
			? `GitHub's branch protection blocked the merge: ${detail}`
			: "GitHub can't merge this pull request yet. Resolve conflicts or wait for required checks, then try again.";
	if (status === 422)
		return "GitHub refused the merge. Refresh the pull request and try again.";
	return null;
}
