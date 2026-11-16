import { useQueries } from "@tanstack/react-query";
import {
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	Search,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type {
	PullRequestFilter,
	RepositoryPullRequest,
} from "#/domain/pull-request-review";
import {
	type GithubRepositoryRef,
	GithubScrollArea,
	LabelChip,
	Time,
} from "./github-ui";
import {
	ChatRail,
	ChecksCell,
	type PullRequestChat,
	ReviewMark,
} from "./pull-request-marks";
import { pullRequestsKey, pullRequestsRequest } from "./work-items-queries";

/** A connected repository the table reads, with the name shown beside its rows. */
export type WorkRepository = GithubRepositoryRef & {
	readonly name: string;
	/** The project this repository is connected through (chats started here belong to it). */
	readonly projectId?: string;
};

export function PullStateIcon({
	state,
}: {
	state: RepositoryPullRequest["state"];
}) {
	const Icon =
		state === "merged"
			? GitMerge
			: state === "closed"
				? GitPullRequestClosed
				: state === "draft"
					? GitPullRequestDraft
					: GitPullRequest;
	return (
		<span className="gh-pull-icon" data-state={state} title={state}>
			<Icon size={16} aria-label={state} />
		</span>
	);
}

/**
 * The dense pull request table, for one repository or for every connected
 * one. Selecting a row opens the in-app review panel.
 */
export function PullRequestList({
	repositories,
	showRepository = false,
	toolbar,
	onOpen,
	chatFor,
	onOpenChat,
}: {
	repositories: readonly WorkRepository[];
	/** Adds a Repo column: the table spans repositories. */
	showRepository?: boolean;
	/** Beside the state tabs (the repository filter). */
	toolbar?: ReactNode;
	onOpen: (pull: RepositoryPullRequest, repository: WorkRepository) => void;
	chatFor?: (
		repository: GithubRepositoryRef,
		head: string,
	) => PullRequestChat | undefined;
	onOpenChat?: (chatId: string) => void;
}) {
	const [filter, setFilter] = useState<PullRequestFilter>("open");
	const [query, setQuery] = useState("");
	const lists = useQueries({
		queries: repositories.map((repository) => ({
			queryKey: pullRequestsKey(repository.repositoryId, filter),
			queryFn: () => pullRequestsRequest(repository, filter),
			refetchInterval: 60_000,
		})),
	});
	const needle = query.trim().toLowerCase();
	const rows = lists
		.flatMap((list, index) =>
			(list.data?.pullRequests ?? []).map((pull) => ({
				pull,
				repository: repositories[index],
			})),
		)
		.sort((a, b) => b.pull.updatedAt.localeCompare(a.pull.updatedAt))
		.filter(
			({ pull }) =>
				!needle ||
				`${pull.title} #${pull.number} ${pull.author} ${pull.head}`
					.toLowerCase()
					.includes(needle) ||
				pull.labels.some((label) => label.name.toLowerCase().includes(needle)),
		);
	const total = lists.reduce(
		(sum, list) => sum + (list.data?.pullRequests.length ?? 0),
		0,
	);
	const failed = lists.filter((list) => list.error);
	const pending = lists.some((list) => list.isPending);
	return (
		<section className="pr gh-repository-list" aria-label="Pull requests">
			<header className="gh-issues-bar">
				<div
					className="gh-filter-tabs"
					role="tablist"
					aria-label="Pull request state"
				>
					{(["open", "merged", "closed", "all"] as const).map((state) => (
						<button
							type="button"
							key={state}
							role="tab"
							aria-selected={filter === state}
							onClick={() => setFilter(state)}
						>
							{state[0].toUpperCase() + state.slice(1)}
							{filter === state && !pending ? <span>{total}</span> : null}
						</button>
					))}
				</div>
				<span className="pr-head-spacer" />
				{toolbar}
			</header>
			<label className="gh-search">
				<Search size={14} aria-hidden="true" />
				<input
					type="search"
					aria-label="Filter pull requests"
					placeholder="Filter pull requests"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</label>
			{failed.length && !pending && failed.length < lists.length ? (
				<p className="gh-partial" role="status">
					Couldn't read {failed.length} of {lists.length} repositories.
				</p>
			) : null}
			<GithubScrollArea className="pr-pane">
				{failed.length === lists.length && failed.length ? (
					<p className="pr-empty" role="alert">
						{failed[0].error?.message}
					</p>
				) : pending && !rows.length ? (
					<p className="pr-empty">Loading pull requests…</p>
				) : !rows.length ? (
					<p className="pr-empty">
						{needle ? "No pull requests match." : "No pull requests."}
					</p>
				) : (
					<table className="gh-table">
						<thead>
							<tr>
								<th scope="col">Pull request</th>
								{showRepository ? <th scope="col">Repo</th> : null}
								<th scope="col">Chat</th>
								<th scope="col">Checks</th>
								<th scope="col">Review</th>
								<th scope="col">Diff</th>
								<th scope="col">Updated</th>
							</tr>
						</thead>
						<tbody>
							{rows.map(({ pull, repository }) => (
								<tr key={`${repository.repositoryId}:${pull.number}`}>
									<td>
										<button
											type="button"
											className="gh-table-open"
											onClick={() => onOpen(pull, repository)}
										>
											<PullStateIcon state={pull.state} />
											<span>
												<span className="gh-table-title">{pull.title}</span>
												<span className="gh-table-meta">
													#{pull.number}
													{pull.state === "draft" ? " · Draft" : ""}
													{pull.labels.map((label) => (
														<LabelChip key={label.name} label={label} />
													))}
												</span>
											</span>
										</button>
									</td>
									{showRepository ? (
										<td>
											<span className="gh-table-repo">{repository.name}</span>
										</td>
									) : null}
									<td>
										<ChatRail
											chat={chatFor?.(repository, pull.head)}
											onOpen={onOpenChat}
										/>
									</td>
									<td>
										<ChecksCell checks={pull.checks} />
									</td>
									<td>
										<ReviewMark mark={pull.review} />
									</td>
									<td>
										{pull.additions !== undefined ? (
											<span className="gh-diffstat">
												<b>+{pull.additions}</b>
												<i>−{pull.deletions ?? 0}</i>
											</span>
										) : (
											<span className="gh-mark-none">—</span>
										)}
									</td>
									<td>
										<Time iso={pull.updatedAt} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</GithubScrollArea>
		</section>
	);
}
