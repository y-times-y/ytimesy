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
	readonly author: string;
	readonly draft: boolean;
};

type GithubUser = {
	login?: string;
	avatar_url?: string;
	type?: string;
} | null;

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
