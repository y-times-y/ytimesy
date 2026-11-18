import { workspacePublicationBranch } from "./publication";
import type { SessionTurnStatus } from "./session-item";
import type { ChatWaitingOn } from "./sidebar-chats";
import type { RepositoryPullRequest } from "./sidebar-pr";
import { threadLabel } from "./thread-label";

/**
 * The Y² chat's inspector overview: the project's threads grouped by what
 * the person should look at, from the sidebar's chat rows and the project's
 * pull request list (no extra reads).
 */

/** The parts of a sidebar chat row the overview reads. */
export type YOverviewThread = {
	readonly id: string;
	readonly title: string;
	readonly turnStatus?: SessionTurnStatus;
	readonly updatedAt?: string | null;
	readonly workspaceId?: string | null;
	readonly workingBranch?: string | null;
	readonly waitingOn?: ChatWaitingOn | null;
	readonly workingSince?: string | null;
	readonly unused?: boolean;
	readonly role?: "y2";
	/** The thread's number in its project (src/domain/thread-label.ts). */
	readonly threadNumber?: number | null;
};

export type NeedsYouRow = {
	readonly threadId: string;
	/** The thread's name ("web-12"), when the overview was given the project's name. */
	readonly label: string | null;
	readonly title: string;
	readonly waitingOn: ChatWaitingOn;
	readonly detail: string;
	readonly updatedAt: string | null;
};

export type InProgressRow = {
	readonly threadId: string;
	readonly label: string | null;
	readonly title: string;
	readonly workingSince: string | null;
	readonly updatedAt: string | null;
};

export type ThreadPullRequestRow = {
	readonly threadId: string;
	readonly threadTitle: string;
	/** The label of the thread that opened it: "via WEB-3F9A". */
	readonly threadLabel: string | null;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/** "web#8357": the repository's short name and the PR number. */
	readonly reference: string;
	readonly title: string;
	readonly url: string;
	readonly base: string | null;
	readonly head: string;
	readonly draft: boolean;
	readonly additions: number | null;
	readonly deletions: number | null;
	readonly updatedAt: string | null;
};

export type YOverview = {
	readonly needsYou: readonly NeedsYouRow[];
	readonly inProgress: readonly InProgressRow[];
	readonly pullRequests: readonly ThreadPullRequestRow[];
};

/** The project's threads: every chat but Y² itself and an opened, never-used one. */
function projectThreads(chats: readonly YOverviewThread[]) {
	return chats.filter((chat) => chat.role !== "y2" && !chat.unused);
}

function threadIsRunning(thread: YOverviewThread) {
	return thread.turnStatus === "running" || Boolean(thread.workingSince);
}

const newestFirst = (
	a: { readonly updatedAt: string | null },
	b: { readonly updatedAt: string | null },
) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

function threadHead(thread: YOverviewThread) {
	const workspaceId = thread.workspaceId?.trim();
	return (
		thread.workingBranch?.trim() ||
		(workspaceId ? workspacePublicationBranch(workspaceId) : null)
	);
}

function labelOf(projectName: string | undefined, thread: YOverviewThread) {
	return projectName ? threadLabel(projectName, thread) : null;
}

/** The repository's name without its owner: "acme/web" reads "web". */
export function repositoryShortName(fullName: string) {
	return fullName.split("/").at(-1) || fullName;
}

/** Open and draft pull requests a thread's branch opened, one per PR. */
function threadPullRequests(
	threads: readonly YOverviewThread[],
	pullRequests: readonly RepositoryPullRequest[],
	projectName: string | undefined,
): ThreadPullRequestRow[] {
	const open = pullRequests.filter((pr) => pr.state === "open" && !pr.merged);
	const rows: ThreadPullRequestRow[] = [];
	const listed = new Set<string>();
	for (const thread of threads) {
		const head = threadHead(thread);
		if (!head) continue;
		for (const pr of open) {
			if (pr.head !== head && !pr.head.endsWith(`:${head}`)) continue;
			const key = `${pr.repositoryId}#${pr.number}`;
			if (listed.has(key)) continue;
			listed.add(key);
			rows.push({
				threadId: thread.id,
				threadTitle: thread.title,
				threadLabel: labelOf(projectName, thread),
				owner: pr.repositoryFullName.split("/")[0] ?? "",
				repo: repositoryShortName(pr.repositoryFullName),
				number: pr.number,
				reference: `${repositoryShortName(pr.repositoryFullName)}#${pr.number}`,
				title: pr.title?.trim() || pr.head,
				url: pr.url,
				base: pr.base ?? null,
				head: pr.head,
				draft: pr.draft,
				additions: pr.additions ?? null,
				deletions: pr.deletions ?? null,
				updatedAt: thread.updatedAt ?? null,
			});
		}
	}
	return rows.sort(newestFirst);
}

/** Threads that wait on the person, threads whose turn runs, and their open PRs. */
export function yOverview(input: {
	readonly chats: readonly YOverviewThread[];
	readonly pullRequests: readonly RepositoryPullRequest[];
	/** The project's thread-label prefix (thread-label.ts); no labels without it. */
	readonly projectName?: string;
}): YOverview {
	const threads = projectThreads(input.chats);
	const needsYou: NeedsYouRow[] = [];
	const inProgress: InProgressRow[] = [];
	for (const thread of threads) {
		const updatedAt = thread.updatedAt ?? null;
		if (thread.waitingOn && !threadIsRunning(thread))
			needsYou.push({
				threadId: thread.id,
				label: labelOf(input.projectName, thread),
				title: thread.title,
				waitingOn: thread.waitingOn,
				detail: needsYouDetail(thread.waitingOn),
				updatedAt,
			});
		else if (threadIsRunning(thread))
			inProgress.push({
				threadId: thread.id,
				label: labelOf(input.projectName, thread),
				title: thread.title,
				workingSince: thread.workingSince ?? null,
				updatedAt,
			});
	}
	return {
		needsYou: needsYou.sort(newestFirst),
		inProgress: inProgress.sort(newestFirst),
		pullRequests: threadPullRequests(
			threads,
			input.pullRequests,
			input.projectName,
		),
	};
}

/** What a Needs-you row waits on, as its second line. */
export function needsYouDetail(waiting: ChatWaitingOn) {
	switch (waiting) {
		case "question":
			return "waiting on your answer";
		case "secret":
			return "waiting on a secret";
		case "push":
			return "waiting on your push approval";
		case "plan":
			return "waiting on your plan approval";
		case "paused":
			return "paused on a model switch";
		case "failed":
			return "last turn failed";
	}
}

/** "running", "running 3m", "running 1h 5m": the in-progress row's second line. */
export function runningForText(since: string | null, nowMs: number) {
	const started = since ? Date.parse(since) : Number.NaN;
	if (!Number.isFinite(started)) return "running";
	const minutes = Math.max(0, Math.floor((nowMs - started) / 60_000));
	if (minutes < 1) return "running";
	if (minutes < 60) return `running ${minutes}m`;
	const rest = minutes % 60;
	return `running ${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
}
