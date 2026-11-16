import type {
	PullRequestLabel,
	PullRequestPerson,
} from "./pull-request-review";

export type IssueState = "open" | "closed";
export type IssueCloseReason = "completed" | "not_planned";

/** One row of the Issues list. */
export type IssueSummary = {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: IssueState;
	readonly stateReason: string | null;
	readonly author: PullRequestPerson;
	readonly labels: readonly PullRequestLabel[];
	readonly assignees: readonly PullRequestPerson[];
	readonly comments: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** An open issue assigned to the signed-in user: the sidebar badge counts it. */
	readonly waiting?: boolean;
	/** Pull requests that close it (read for open issues; absent when GitHub would not say). */
	readonly pullRequests?: readonly IssuePullRequestRef[];
};

/** A pull request that closes an issue, as the Issues table shows it. */
export type IssuePullRequestRef = {
	readonly number: number;
	readonly state: "open" | "draft" | "merged" | "closed";
	/** Its branch: how the chat working on it is found. */
	readonly head: string;
};

/** The title a chat started from an issue gets (see startIssueChat). */
export const ISSUE_CHAT_TITLE = /^Issue #(\d+):/;

/**
 * The issue a chat was started for, from its title. A chat renamed by hand
 * no longer says; one with a pull request is found through its branch too.
 */
export function issueNumberFromChatTitle(title: string): number | null {
	const match = ISSUE_CHAT_TITLE.exec(title);
	return match ? Number(match[1]) : null;
}

/**
 * The chat working on an issue: the one on a pull request that closes it
 * (by branch), else the one started for it (by title). Newest-first lists
 * mean the first match is the freshest.
 */
export function chatForIssue<Chat>(input: {
	readonly pullRequests: readonly IssuePullRequestRef[] | undefined;
	readonly byHead: ReadonlyMap<string, Chat> | undefined;
	readonly byIssue: ReadonlyMap<number, Chat> | undefined;
	readonly number: number;
}): Chat | undefined {
	for (const pull of input.pullRequests ?? []) {
		const chat = input.byHead?.get(pull.head);
		if (chat) return chat;
	}
	return input.byIssue?.get(input.number);
}

export type IssueComment = {
	readonly id: number;
	readonly author: PullRequestPerson;
	readonly body: string;
	readonly createdAt: string;
	readonly url: string | null;
};

/** A pull request that will close the issue when it merges. */
export type IssueLinkedPullRequest = {
	readonly number: number;
	readonly title: string;
	readonly url: string;
	readonly state: "open" | "closed" | "merged";
};

export type IssueDetail = IssueSummary & {
	readonly body: string;
	readonly conversation: readonly IssueComment[];
	readonly linkedPullRequests: readonly IssueLinkedPullRequest[];
	/** The signed-in user's GitHub login: their own comments can be edited. */
	readonly viewer: string | null;
};

/** A change to the repository's issues made from the Issues panel. */
export type IssueWriteAction =
	| {
			readonly action: "create";
			readonly title: string;
			readonly body: string;
			readonly labels: readonly string[];
			readonly assignees: readonly string[];
	  }
	| {
			readonly action: "edit";
			readonly number: number;
			readonly title?: string;
			readonly body?: string;
	  }
	| {
			readonly action: "state";
			readonly number: number;
			readonly state: IssueState;
			readonly reason?: IssueCloseReason;
	  }
	| {
			readonly action: "comment";
			readonly number: number;
			readonly body: string;
	  }
	| {
			readonly action: "edit-comment";
			readonly number: number;
			readonly commentId: number;
			readonly body: string;
	  }
	| {
			readonly action: "delete-comment";
			readonly number: number;
			readonly commentId: number;
	  }
	| {
			readonly action: "labels";
			readonly number: number;
			readonly labels: readonly string[];
	  }
	| {
			readonly action: "assignees";
			readonly number: number;
			readonly add: readonly string[];
			readonly remove: readonly string[];
	  };

/** The first message of a chat started from an issue: what to do and where. */
export function issueChatMessage(issue: {
	readonly fullName: string;
	readonly number: number;
	readonly title: string;
	readonly url: string;
}): string {
	const title = issue.title.replace(/\s+/g, " ").trim().slice(0, 200);
	return `Work on issue #${issue.number} "${title}" in ${issue.fullName} (${issue.url}). Read the issue and its comments, make the change on a new branch, and open a pull request that closes #${issue.number}.`;
}

const GITHUB_ISSUE_URL =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/;

/** `owner/repo` and the number from a github.com issue URL. */
export function githubIssueFromUrl(
	url: string,
): { readonly fullName: string; readonly number: number } | null {
	const match = GITHUB_ISSUE_URL.exec(url.trim());
	return match ? { fullName: match[1], number: Number(match[2]) } : null;
}

/** Readable text color (dark or light) on a GitHub label color. */
export function labelTextColor(hex: string): "#0b0b0b" | "#f5f5f5" {
	const value = /^[0-9a-f]{6}$/i.test(hex) ? hex : "777777";
	const [r, g, b] = [0, 2, 4].map((at) =>
		Number.parseInt(value.slice(at, at + 2), 16),
	);
	return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0b0b0b" : "#f5f5f5";
}
