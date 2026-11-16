/**
 * What a user can change on GitHub from ytimesy, and how GitHub's refusals
 * read in the app. Everything runs with the user's own GitHub token, so a
 * comment or review is theirs, not a bot's.
 */

/** A GitHub App permission an action needs beyond what reading uses. */
export type GithubWritePermission =
	| "Pull requests: write"
	| "Issues: write"
	| "Actions: write"
	| "Actions: read";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type DiffSide = "LEFT" | "RIGHT";

/** A comment on one diff line, posted alone or as part of a review. */
export type ReviewLineComment = {
	readonly path: string;
	readonly line: number;
	readonly side: DiffSide;
	readonly body: string;
};

/** A change to a pull request made from the review panel. */
export type PullRequestWriteAction =
	| { readonly action: "comment"; readonly body: string }
	| {
			readonly action: "reply";
			/** The review comment that starts the thread. */
			readonly commentId: number;
			readonly body: string;
	  }
	| {
			readonly action: "edit-comment";
			readonly kind: "comment" | "inline";
			readonly commentId: number;
			readonly body: string;
	  }
	| {
			readonly action: "delete-comment";
			readonly kind: "comment" | "inline";
			readonly commentId: number;
	  }
	| {
			readonly action: "resolve-thread";
			readonly threadId: string;
			readonly resolved: boolean;
	  }
	| {
			readonly action: "review";
			readonly event: ReviewEvent;
			readonly body: string;
			/** The head the reviewer read; comments anchor to it. */
			readonly headSha: string;
			readonly comments: readonly ReviewLineComment[];
	  }
	| ({
			readonly action: "line-comment";
			readonly headSha: string;
	  } & ReviewLineComment)
	| { readonly action: "state"; readonly state: "open" | "closed" }
	| { readonly action: "edit"; readonly title?: string; readonly body?: string }
	| {
			readonly action: "reviewers";
			readonly add: readonly string[];
			readonly remove: readonly string[];
	  }
	| { readonly action: "labels"; readonly labels: readonly string[] }
	| {
			readonly action: "assignees";
			readonly add: readonly string[];
			readonly remove: readonly string[];
	  }
	| {
			readonly action: "rerun";
			/** One job again, or every failed job of a workflow run. */
			readonly target:
				| { readonly jobId: number }
				| { readonly failedInRunId: number };
	  };

/** The permission each pull request change needs from the GitHub App. */
export function pullRequestActionPermission(
	action: PullRequestWriteAction["action"],
): GithubWritePermission {
	return action === "rerun" ? "Actions: write" : "Pull requests: write";
}

/**
 * A message for GitHub refusing a change, or null for failures that are not
 * the user's to fix. A 403 "not accessible by integration" means the GitHub
 * App lacks the permission (an owner approves it on GitHub); other refusals
 * pass GitHub's own reason through.
 */
export function githubWriteFailure(
	error: unknown,
	permission: GithubWritePermission,
): { readonly status: number; readonly message: string } | null {
	if (typeof error !== "object" || error === null || !("status" in error))
		return null;
	const status = Number(error.status);
	const detail =
		"message" in error && typeof error.message === "string"
			? error.message.split(" - http")[0].trim()
			: "";
	if (status === 403 && /not accessible by integration/i.test(detail))
		return {
			status: 403,
			message: `ytimesy's GitHub App needs the "${permission}" permission for this. An owner of the repository can approve it on GitHub (Settings → Applications → ytimesy).`,
		};
	if (status === 403 || status === 422 || status === 404 || status === 409)
		return {
			status: 409,
			message:
				detail && !/^unknown error$/i.test(detail)
					? `GitHub refused this: ${detail}`
					: permission === "Actions: write"
						? "GitHub did not accept the re-run. Usually GitHub Actions is blocked for the account (a failed payment or a spending limit), or the workflow no longer exists. Open the check on GitHub for the reason."
						: "GitHub refused this change.",
		};
	return null;
}

/** A suggested change for a line comment, in GitHub's suggestion syntax. */
export function suggestionBlock(lines: string): string {
	return `\`\`\`suggestion\n${lines}\n\`\`\``;
}

const ACTIONS_JOB_URL =
	/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/(\d+)(?:[/?#]|$)/;

/** The workflow run and job behind a GitHub Actions check, from its page URL. */
export function actionsJobFromUrl(
	url: string | null | undefined,
): { readonly runId: number; readonly jobId: number } | null {
	const match = url ? ACTIONS_JOB_URL.exec(url) : null;
	if (!match) return null;
	const runId = Number(match[1]);
	const jobId = Number(match[2]);
	return Number.isSafeInteger(runId) &&
		runId > 0 &&
		Number.isSafeInteger(jobId) &&
		jobId > 0
		? { runId, jobId }
		: null;
}

/** The last lines of a job log, without timestamps, where the failure usually is. */
export function logTail(log: string, lines = 120, chars = 8000) {
	const tail = log
		.split(/\r?\n/)
		.map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ""))
		.filter((line) => line.trim())
		.slice(-lines)
		.join("\n");
	return tail.length > chars ? tail.slice(-chars) : tail;
}

/** Logins in `next` not in `current`, and the other way round. */
export function loginChanges(
	current: readonly string[],
	next: readonly string[],
): { readonly add: string[]; readonly remove: string[] } {
	const before = new Set(current.map((login) => login.toLowerCase()));
	const after = new Set(next.map((login) => login.toLowerCase()));
	return {
		add: next.filter((login) => !before.has(login.toLowerCase())),
		remove: current.filter((login) => !after.has(login.toLowerCase())),
	};
}
