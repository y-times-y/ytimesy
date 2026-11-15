import { useQuery } from "@tanstack/react-query";
import {
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	Search,
} from "lucide-react";
import { useState } from "react";
import type {
	PullRequestFilter,
	RepositoryPullRequest,
} from "#/domain/pull-request-review";
import { requestJson } from "../projects/api";
import {
	Avatar,
	type GithubRepositoryRef,
	GithubScrollArea,
	LabelChip,
	Time,
} from "./github-ui";

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

/** The dense repository table. Selecting a row opens the in-app review panel. */
export function PullRequestList({
	repository,
	onOpen,
}: {
	repository: GithubRepositoryRef;
	onOpen: (pull: RepositoryPullRequest) => void;
}) {
	const [filter, setFilter] = useState<PullRequestFilter>("open");
	const [query, setQuery] = useState("");
	const list = useQuery({
		queryKey: ["pull-requests", repository.repositoryId, filter],
		queryFn: () =>
			requestJson<{ pullRequests: RepositoryPullRequest[] }>(
				`/api/github/pull-request?${new URLSearchParams({ installationId: String(repository.installationId), repositoryId: String(repository.repositoryId), state: filter })}`,
			),
		refetchInterval: 60_000,
	});
	const needle = query.trim().toLowerCase();
	const pulls = (list.data?.pullRequests ?? []).filter(
		(pull) =>
			!needle ||
			`${pull.title} #${pull.number} ${pull.author} ${pull.head}`
				.toLowerCase()
				.includes(needle) ||
			pull.labels.some((label) => label.name.toLowerCase().includes(needle)),
	);
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
							{filter === state && list.data ? (
								<span>{list.data.pullRequests.length}</span>
							) : null}
						</button>
					))}
				</div>
			</header>
			<label className="gh-search">
				<Search size={14} aria-hidden="true" />
				<input
					type="search"
					aria-label="Filter pull requests"
					placeholder="Filter by title, number, author or label"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</label>
			<GithubScrollArea className="pr-pane">
				{list.error ? (
					<p className="pr-empty" role="alert">
						{list.error.message}
					</p>
				) : list.isPending ? (
					<p className="pr-empty">Loading pull requests…</p>
				) : !pulls.length ? (
					<p className="pr-empty">
						{needle ? "No pull requests match." : "No pull requests."}
					</p>
				) : (
					<table className="gh-table">
						<thead>
							<tr>
								<th scope="col">Pull request</th>
								<th scope="col">Author</th>
								<th scope="col">Branch</th>
								<th scope="col">Updated</th>
							</tr>
						</thead>
						<tbody>
							{pulls.map((pull) => (
								<tr key={pull.number}>
									<td>
										<button
											type="button"
											className="gh-table-open"
											onClick={() => onOpen(pull)}
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
									<td>
										<span className="gh-person">
											<Avatar
												person={{
													login: pull.author,
													avatarUrl: pull.authorAvatarUrl,
													bot: pull.author.endsWith("[bot]"),
												}}
												size={18}
											/>
											{pull.author}
										</span>
									</td>
									<td>
										<code
											className="gh-table-branch"
											title={`${pull.head} → ${pull.base}`}
										>
											{pull.head} → {pull.base}
										</code>
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
