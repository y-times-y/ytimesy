import type { AgentProviderId } from "./agent-provider";
import type { FileChangeEntry } from "./session-item";

export type PullRequestCheck = {
	readonly name: string;
	readonly state: "passed" | "failed" | "pending" | "skipped";
	readonly url: string | null;
	/** The GitHub Actions job behind the check, which can be re-run and whose log can be read. */
	readonly job?: { readonly runId: number; readonly jobId: number } | null;
};

export type PullRequestLabel = {
	readonly name: string;
	/** Hex without '#', as GitHub sends it. */
	readonly color: string;
	readonly description?: string | null;
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
	/** GitHub's id, for replying, editing and deleting. */
	readonly databaseId?: number;
	/** An inline reply names the comment that started its thread. */
	readonly inReplyTo?: number | null;
	readonly side?: "LEFT" | "RIGHT" | null;
	/** The review thread an inline comment starts, for resolving it. */
	readonly thread?: { readonly id: string; readonly resolved: boolean } | null;
};

/** A conversation entry with the inline replies that answer it. */
export type PullRequestThreadEntry = PullRequestComment & {
	readonly replies: readonly PullRequestComment[];
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
	/** The signed-in user's GitHub login: their own comments can be edited. */
	readonly viewer?: string | null;
	readonly labels?: readonly PullRequestLabel[];
	readonly assignees?: readonly PullRequestPerson[];
	readonly requestedReviewers?: readonly PullRequestPerson[];
};

/** Labels and people a repository offers for labelling, assigning and review requests. */
export type RepositoryChoices = {
	readonly labels: readonly PullRequestLabel[];
	readonly people: readonly PullRequestPerson[];
};

/**
 * The conversation with each inline reply moved under the comment that
 * started its thread, in time order. A reply whose thread start is gone
 * stays on its own.
 */
export function groupReviewThreads(
	conversation: readonly PullRequestComment[],
): PullRequestThreadEntry[] {
	const roots = new Map<number, PullRequestComment[]>();
	for (const entry of conversation)
		if (entry.kind === "inline" && !entry.inReplyTo && entry.databaseId)
			roots.set(entry.databaseId, []);
	const entries: PullRequestComment[] = [];
	for (const entry of conversation) {
		const thread =
			entry.kind === "inline" && entry.inReplyTo
				? roots.get(entry.inReplyTo)
				: undefined;
		if (thread) thread.push(entry);
		else entries.push(entry);
	}
	return entries.map((entry) => ({
		...entry,
		replies:
			(entry.databaseId !== undefined && roots.get(entry.databaseId)) || [],
	}));
}

/** Whether the signed-in user wrote this entry (and so may edit or delete it). */
export function viewerWrote(
	entry: Pick<PullRequestComment, "author">,
	viewer: string | null | undefined,
): boolean {
	return (
		Boolean(viewer) &&
		entry.author.login.toLowerCase() === viewer?.toLowerCase()
	);
}

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

/** What a pull request's review comes to, as one mark: who did what, or who is asked. */
export type PullRequestReviewMark =
	| { readonly kind: "approved"; readonly by: PullRequestPerson }
	| { readonly kind: "changes"; readonly by: PullRequestPerson }
	/** `you`: the signed-in user is among those asked; `from` is then them. */
	| {
			readonly kind: "requested";
			readonly from: PullRequestPerson;
			readonly you: boolean;
	  };

/** How many of a head's checks are done, failing or still running. */
export type PullRequestChecksCount = {
	readonly passed: number;
	readonly failed: number;
	readonly pending: number;
};

/** A repository table row; the compact open-PR picker keeps its smaller model. */
export type RepositoryPullRequest = ListedRepositoryPullRequest & {
	readonly state: PullRequestDetail["state"];
	readonly head: string;
	readonly base: string;
	readonly updatedAt: string;
	readonly labels: readonly PullRequestLabel[];
	/** Read for open pull requests only; absent when GitHub would not say. */
	readonly review?: PullRequestReviewMark | null;
	readonly checks?: PullRequestChecksCount | null;
	readonly additions?: number;
	readonly deletions?: number;
	/** The signed-in user has something to do here (see pullRequestWaitingOnYou). */
	readonly waiting?: boolean;
	/** Issues this pull request closes when it merges. */
	readonly closes?: readonly number[];
};

/**
 * Whether an open pull request is waiting on the signed-in user: they were
 * asked to review it, or it is theirs and ready to merge (approved, and every
 * check passed). Counted by the sidebar badge; never "everything open".
 */
export function pullRequestWaitingOnYou(input: {
	readonly state: string;
	readonly author: string;
	readonly viewer: string | null;
	readonly review: PullRequestReviewMark | null | undefined;
	readonly checks: PullRequestChecksCount | null | undefined;
}): boolean {
	if (input.state !== "open" || !input.viewer) return false;
	if (input.review?.kind === "requested" && input.review.you) return true;
	const mine = input.author.toLowerCase() === input.viewer.toLowerCase();
	const checks = input.checks;
	return Boolean(
		mine &&
			input.review?.kind === "approved" &&
			checks &&
			checks.passed > 0 &&
			checks.failed === 0 &&
			checks.pending === 0,
	);
}

/**
 * The one review mark for a pull request. A reviewer's latest verdict counts:
 * a request for changes outranks an approval (the pull request is not ready),
 * both outrank a pending request, and a request to the signed-in user shows
 * them in preference to someone else who was asked.
 */
export function reviewMarkFrom(input: {
	/** Each reviewer's latest approving or change-requesting review. */
	readonly decisions: readonly {
		readonly state: string;
		readonly person: PullRequestPerson;
	}[];
	readonly requested: readonly PullRequestPerson[];
	readonly viewer: string | null;
}): PullRequestReviewMark | null {
	const changes = input.decisions.find(
		(decision) => decision.state === "CHANGES_REQUESTED",
	);
	if (changes) return { kind: "changes", by: changes.person };
	const approval = input.decisions.find(
		(decision) => decision.state === "APPROVED",
	);
	if (approval) return { kind: "approved", by: approval.person };
	const viewer = input.viewer?.toLowerCase();
	const you = input.requested.find(
		(person) => viewer && person.login.toLowerCase() === viewer,
	);
	const from = you ?? input.requested[0];
	return from ? { kind: "requested", from, you: Boolean(you) } : null;
}

/** Counts of a head's check results, by the state each reduces to. */
export function checksCountFrom(
	results: readonly {
		readonly status?: string | null;
		readonly conclusion?: string | null;
		readonly state?: string | null;
	}[],
): PullRequestChecksCount | null {
	if (!results.length) return null;
	const count = { passed: 0, failed: 0, pending: 0 };
	for (const result of results) {
		const state = checkState(result);
		if (state === "passed") count.passed += 1;
		else if (state === "failed") count.failed += 1;
		else if (state === "pending") count.pending += 1;
	}
	return count;
}

export type PullRequestFilter = "open" | "merged" | "closed" | "all";

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
