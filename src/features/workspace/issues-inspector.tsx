import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	ArrowLeft,
	CircleCheck,
	CircleDot,
	CircleSlash,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	MessageSquare,
	Pencil,
	Plus,
	Search,
} from "lucide-react";
import { useRef, useState } from "react";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import type {
	IssueComment,
	IssueDetail,
	IssueState,
	IssueSummary,
	IssueWriteAction,
} from "#/domain/github-issues";
import { loginChanges } from "#/domain/github-write";
import type {
	PullRequestLabel,
	PullRequestPerson,
} from "#/domain/pull-request-review";
import { viewerWrote } from "#/domain/pull-request-review";
import { requestJson } from "../projects/api";
import { startIssueChatFn } from "../pull-requests/issue-chat.fn";
import {
	Avatar,
	ChoiceField,
	displayName,
	EditableBody,
	type GithubRepositoryRef,
	GithubScrollArea,
	LabelChip,
	MarkdownComposer,
	OwnCommentMenu,
	PersonOption,
	Time,
	useGithubAction,
	useRepositoryChoices,
} from "./github-ui";
import "./pull-request-inspector.css";

type Filter = IssueState | "all";
type Screen =
	| { readonly kind: "list" }
	| { readonly kind: "issue"; readonly number: number }
	| { readonly kind: "new" };

type ChatStart = {
	readonly projectId?: string;
	readonly harnessId?: AgentProviderId;
	readonly modelId?: string;
	/** Opens the chat an issue started. */
	readonly onChatStarted?: (sessionId: string) => void;
	readonly onOpenPullRequest?: (number: number) => void;
};

const API = "/api/github/issue";

function issuesPath(
	repository: GithubRepositoryRef,
	extra: Record<string, string>,
) {
	return `${API}?${new URLSearchParams({
		installationId: String(repository.installationId),
		repositoryId: String(repository.repositoryId),
		...extra,
	})}`;
}

export function IssueStateIcon({
	issue,
	size = 16,
}: {
	issue: Pick<IssueSummary, "state" | "stateReason">;
	size?: number;
}) {
	if (issue.state === "open")
		return <CircleDot size={size} data-tone="ok" aria-label="Open" />;
	if (issue.stateReason === "not_planned")
		return (
			<CircleSlash
				size={size}
				data-tone="none"
				aria-label="Closed as not planned"
			/>
		);
	return (
		<CircleCheck
			size={size}
			data-tone="merged"
			aria-label="Closed as completed"
		/>
	);
}

/**
 * The repository's issues in the side panel: find one, read and answer it,
 * label, assign, close, or hand it to a new chat, without opening GitHub.
 */
export function IssuesInspector({
	repository,
	...chat
}: { repository: GithubRepositoryRef } & ChatStart) {
	const [screen, setScreen] = useState<Screen>({ kind: "list" });
	const [filter, setFilter] = useState<Filter>("open");
	if (screen.kind === "issue")
		return (
			<IssuePage
				key={screen.number}
				repository={repository}
				number={screen.number}
				onBack={() => setScreen({ kind: "list" })}
				{...chat}
			/>
		);
	if (screen.kind === "new")
		return (
			<NewIssue
				repository={repository}
				onBack={() => setScreen({ kind: "list" })}
				onCreated={(number) => setScreen({ kind: "issue", number })}
			/>
		);
	return (
		<IssueList
			repository={repository}
			filter={filter}
			onFilter={setFilter}
			onOpen={(number) => setScreen({ kind: "issue", number })}
			onNew={() => setScreen({ kind: "new" })}
		/>
	);
}

function IssueList({
	repository,
	filter,
	onFilter,
	onOpen,
	onNew,
}: {
	repository: GithubRepositoryRef;
	filter: Filter;
	onFilter: (filter: Filter) => void;
	onOpen: (number: number) => void;
	onNew: () => void;
}) {
	const [query, setQuery] = useState("");
	const list = useQuery({
		queryKey: ["issues", repository.repositoryId, filter],
		queryFn: () =>
			requestJson<{ issues: IssueSummary[] }>(
				issuesPath(repository, { state: filter }),
			),
		refetchInterval: 60_000,
	});
	const needle = query.trim().toLowerCase();
	const issues = (list.data?.issues ?? []).filter(
		(issue) =>
			!needle ||
			issue.title.toLowerCase().includes(needle) ||
			`#${issue.number}`.includes(needle) ||
			issue.labels.some((label) => label.name.toLowerCase().includes(needle)),
	);
	const filters: { id: Filter; label: string }[] = [
		{ id: "open", label: "Open" },
		{ id: "closed", label: "Closed" },
		{ id: "all", label: "All" },
	];
	return (
		<section className="pr gh-issues" aria-label="Issues">
			<header className="gh-issues-bar">
				<div className="gh-filter-tabs" role="tablist" aria-label="Issue state">
					{filters.map((item) => (
						<button
							key={item.id}
							type="button"
							role="tab"
							aria-selected={filter === item.id}
							onClick={() => onFilter(item.id)}
						>
							{item.label}
							{filter === item.id && list.data ? (
								<span>{list.data.issues.length}</span>
							) : null}
						</button>
					))}
				</div>
				<span className="pr-head-spacer" />
				<button
					type="button"
					className="pr-button"
					data-variant="primary"
					onClick={onNew}
				>
					<Plus size={14} aria-hidden="true" />
					New issue
				</button>
			</header>
			<label className="gh-search">
				<Search size={14} aria-hidden="true" />
				<input
					type="search"
					placeholder="Filter by title, number or label"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					aria-label="Filter issues"
				/>
			</label>
			<GithubScrollArea className="pr-pane">
				{list.error ? (
					<p className="pr-empty" role="alert">
						{list.error.message}
					</p>
				) : list.isPending ? (
					<p className="pr-empty">Loading issues…</p>
				) : issues.length === 0 ? (
					<p className="pr-empty">
						{needle
							? "No issues match."
							: filter === "open"
								? "No open issues."
								: "No issues."}
					</p>
				) : (
					<table className="gh-table gh-issues-table">
						<thead>
							<tr>
								<th scope="col">Issue</th>
								<th scope="col">Assignees / comments</th>
							</tr>
						</thead>
						<tbody>
							{issues.map((issue) => (
								<tr key={issue.number}>
									<td>
										<button
											type="button"
											className="gh-issue-row"
											onClick={() => onOpen(issue.number)}
										>
											<IssueStateIcon issue={issue} />
											<span className="gh-issue-main">
												<span className="gh-issue-title">
													{issue.title}
													{issue.labels.map((label) => (
														<LabelChip key={label.name} label={label} />
													))}
												</span>
												<span className="gh-issue-meta">
													#{issue.number} · {displayName(issue.author)} ·{" "}
													<Time iso={issue.updatedAt} />
												</span>
											</span>
										</button>
									</td>
									<td>
										<span className="gh-issue-side">
											{issue.assignees.length ? (
												<span className="pr-avatars">
													{issue.assignees.slice(0, 3).map((person) => (
														<Avatar
															key={person.login}
															person={person}
															size={16}
														/>
													))}
												</span>
											) : null}
											{issue.comments ? (
												<span className="gh-issue-comments">
													<MessageSquare size={12} aria-hidden="true" />
													{issue.comments}
												</span>
											) : null}
										</span>
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

/** Labels and assignees of an issue, editable from menus. */
function IssueFields({
	repository,
	labels,
	assignees,
	onLabels,
	onAssignees,
	busy,
}: {
	repository: GithubRepositoryRef;
	labels: readonly PullRequestLabel[];
	assignees: readonly PullRequestPerson[];
	onLabels: (next: PullRequestLabel[]) => void;
	onAssignees: (next: PullRequestPerson[]) => void;
	busy?: boolean;
}) {
	const [wanted, setWanted] = useState(false);
	const choices = useRepositoryChoices(API, repository, wanted);
	return (
		<div className="gh-fields">
			<ChoiceField
				onOpen={() => setWanted(true)}
				title="Assignees"
				empty="No one"
				selected={assignees}
				options={choices.data?.people}
				loading={choices.isFetching}
				busy={busy}
				keyOf={(person) => person.login}
				renderValue={(person) => <PersonOption person={person} />}
				renderOption={(person) => <PersonOption person={person} />}
				onApply={onAssignees}
			/>
			<ChoiceField
				onOpen={() => setWanted(true)}
				title="Labels"
				empty="None yet"
				selected={labels}
				options={choices.data?.labels}
				loading={choices.isFetching}
				busy={busy}
				keyOf={(label) => label.name}
				renderValue={(label) => <LabelChip label={label} />}
				renderOption={(label) => <LabelChip label={label} />}
				onApply={onLabels}
			/>
			{choices.error ? (
				<p className="gh-error" role="alert">
					{choices.error.message}
				</p>
			) : null}
		</div>
	);
}

function IssuePage({
	repository,
	number,
	onBack,
	projectId,
	harnessId,
	modelId,
	onChatStarted,
	onOpenPullRequest,
}: {
	repository: GithubRepositoryRef;
	number: number;
	onBack: () => void;
} & ChatStart) {
	const cache = useQueryClient();
	const key = ["issue", repository.repositoryId, number] as const;
	const detail = useQuery({
		queryKey: key,
		queryFn: () =>
			requestJson<IssueDetail>(
				issuesPath(repository, { number: String(number) }),
			),
		refetchInterval: 30_000,
	});
	const write = async (input: IssueWriteAction) => {
		const next = await requestJson<IssueDetail>(API, {
			...repository,
			...input,
		});
		cache.setQueryData(key, next);
		void cache.invalidateQueries({
			queryKey: ["issues", repository.repositoryId],
		});
		return next;
	};
	const fields = useGithubAction(write);
	const issue = detail.data;
	return (
		<section className="pr gh-issue" aria-label={`Issue #${number}`}>
			<header className="pr-head">
				<div className="pr-head-bar">
					<button
						type="button"
						className="pr-ghost"
						onClick={onBack}
						aria-label="All issues"
					>
						<ArrowLeft size={14} />
						Issues
					</button>
					{issue ? (
						<span
							className="pr-state"
							data-state={issue.state === "open" ? "open" : "closed"}
						>
							<IssueStateIcon issue={issue} size={12} />
							{issue.state === "open"
								? "Open"
								: issue.stateReason === "not_planned"
									? "Not planned"
									: "Closed"}
						</span>
					) : null}
					<span className="pr-muted">#{number}</span>
					<span className="pr-head-spacer" />
					{issue ? (
						<StartIssueChat
							issue={issue}
							projectId={projectId}
							harnessId={harnessId}
							modelId={modelId}
							onChatStarted={onChatStarted}
						/>
					) : null}
					{issue ? (
						<a
							className="pr-ghost"
							href={issue.url}
							target="_blank"
							rel="noreferrer"
							aria-label="Open on GitHub"
							title="Open on GitHub"
						>
							<ExternalLink size={14} />
						</a>
					) : null}
				</div>
				{issue ? (
					<IssueTitle
						title={issue.title}
						onSave={(title) => write({ action: "edit", number, title })}
					/>
				) : null}
				{issue ? (
					<div className="pr-byline">
						<Avatar person={issue.author} size={18} />
						<span>
							<strong>{displayName(issue.author)}</strong> opened this issue{" "}
							<Time iso={issue.createdAt} /> · {issue.comments}{" "}
							{issue.comments === 1 ? "comment" : "comments"}
						</span>
					</div>
				) : null}
			</header>
			<GithubScrollArea className="pr-pane">
				{!issue ? (
					<p className="pr-empty" role={detail.error ? "alert" : undefined}>
						{detail.error?.message ?? "Loading issue…"}
					</p>
				) : (
					<div className="pr-thread">
						<IssueFields
							repository={repository}
							labels={issue.labels}
							assignees={issue.assignees}
							busy={fields.pending}
							onLabels={(next) =>
								void fields.run({
									action: "labels",
									number,
									labels: next.map((label) => label.name),
								})
							}
							onAssignees={(next) =>
								void fields.run({
									action: "assignees",
									number,
									...loginChanges(
										issue.assignees.map((person) => person.login),
										next.map((person) => person.login),
									),
								})
							}
						/>
						{fields.error ? (
							<p className="gh-error" role="alert">
								{fields.error}
							</p>
						) : null}
						{issue.linkedPullRequests.length ? (
							<ul className="gh-linked">
								{issue.linkedPullRequests.map((pull) => (
									<li key={pull.number}>
										{pull.state === "merged" ? (
											<GitMerge size={14} data-tone="merged" />
										) : (
											<GitPullRequest
												size={14}
												data-tone={pull.state === "open" ? "ok" : "bad"}
											/>
										)}
										<button
											type="button"
											className="pr-link"
											onClick={() => onOpenPullRequest?.(pull.number)}
										>
											#{pull.number} {pull.title}
										</button>
									</li>
								))}
							</ul>
						) : null}
						<ol>
							<IssueBody issue={issue} write={write} />
							{issue.conversation.map((comment) => (
								<IssueCommentItem
									key={comment.id}
									comment={comment}
									issue={issue}
									write={write}
								/>
							))}
						</ol>
						<IssueCommentBox issue={issue} write={write} />
					</div>
				)}
			</GithubScrollArea>
		</section>
	);
}

function IssueTitle({
	title,
	onSave,
}: {
	title: string;
	onSave: (title: string) => Promise<unknown>;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const save = useGithubAction(onSave);
	if (draft === null)
		return (
			<h2 className="pr-title gh-title">
				{title}
				<button
					type="button"
					className="pr-ghost gh-title-edit"
					aria-label="Edit title"
					title="Edit title"
					onClick={() => setDraft(title)}
				>
					<Pencil size={13} />
				</button>
			</h2>
		);
	return (
		<form
			className="gh-title-form"
			onSubmit={async (event) => {
				event.preventDefault();
				const next = draft.trim();
				if (!next || next === title) return setDraft(null);
				if (await save.run(next)) setDraft(null);
			}}
		>
			<input
				aria-label="Title"
				value={draft}
				maxLength={256}
				// biome-ignore lint/a11y/noAutofocus: the user asked to edit the title
				autoFocus
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setDraft(null);
				}}
			/>
			<button
				type="button"
				className="pr-button"
				onClick={() => setDraft(null)}
			>
				Cancel
			</button>
			<button
				type="submit"
				className="pr-button"
				data-variant="primary"
				disabled={save.pending}
			>
				{save.pending ? "Saving…" : "Save"}
			</button>
			{save.error ? (
				<p className="gh-error" role="alert">
					{save.error}
				</p>
			) : null}
		</form>
	);
}

function IssueBody({
	issue,
	write,
}: {
	issue: IssueDetail;
	write: (input: IssueWriteAction) => Promise<unknown>;
}) {
	const [editing, setEditing] = useState(false);
	const save = useGithubAction(write);
	return (
		<li className="pr-comment">
			<Avatar person={issue.author} size={24} />
			<div className="pr-comment-main">
				<p className="pr-comment-head">
					<strong>{displayName(issue.author)}</strong>
					<span>opened this issue</span>
					<span aria-hidden>·</span>
					<Time iso={issue.createdAt} href={issue.url} />
					<span className="gh-comment-menu-slot">
						<button
							type="button"
							className="pr-ghost gh-edit"
							onClick={() => setEditing(true)}
						>
							Edit
						</button>
					</span>
				</p>
				<EditableBody
					text={issue.body}
					editing={editing}
					saving={save.pending}
					error={save.error}
					onCancel={() => setEditing(false)}
					onSave={async (body) => {
						if (await save.run({ action: "edit", number: issue.number, body }))
							setEditing(false);
					}}
				/>
			</div>
		</li>
	);
}

function IssueCommentItem({
	comment,
	issue,
	write,
}: {
	comment: IssueComment;
	issue: IssueDetail;
	write: (input: IssueWriteAction) => Promise<unknown>;
}) {
	const [editing, setEditing] = useState(false);
	const save = useGithubAction(write);
	const own = viewerWrote(comment, issue.viewer);
	return (
		<li className="pr-comment">
			<Avatar person={comment.author} size={24} />
			<div className="pr-comment-main">
				<p className="pr-comment-head">
					<strong>{displayName(comment.author)}</strong>
					{comment.author.bot ? <span className="pr-bot">Bot</span> : null}
					<span>commented</span>
					<span aria-hidden>·</span>
					<Time iso={comment.createdAt} href={comment.url} />
					{own ? (
						<span className="gh-comment-menu-slot">
							<OwnCommentMenu
								onEdit={() => setEditing(true)}
								onDelete={() =>
									void save.run({
										action: "delete-comment",
										number: issue.number,
										commentId: comment.id,
									})
								}
							/>
						</span>
					) : null}
				</p>
				<EditableBody
					text={comment.body}
					editing={editing}
					saving={save.pending}
					error={save.error}
					emptyText=""
					onCancel={() => setEditing(false)}
					onSave={async (body) => {
						if (
							await save.run({
								action: "edit-comment",
								number: issue.number,
								commentId: comment.id,
								body,
							})
						)
							setEditing(false);
					}}
				/>
				{!editing && save.error ? (
					<p className="gh-error" role="alert">
						{save.error}
					</p>
				) : null}
			</div>
		</li>
	);
}

/** Comment, and close (as completed or not planned) or reopen, like GitHub's box. */
function IssueCommentBox({
	issue,
	write,
}: {
	issue: IssueDetail;
	write: (input: IssueWriteAction) => Promise<unknown>;
}) {
	const [text, setText] = useState("");
	const number = issue.number;
	const act = useGithubAction(
		async (input: "comment" | "completed" | "not_planned" | "reopen") => {
			if (text.trim()) {
				await write({ action: "comment", number, body: text });
				setText("");
			}
			if (input === "reopen")
				await write({ action: "state", number, state: "open" });
			else if (input !== "comment")
				await write({
					action: "state",
					number,
					state: "closed",
					reason: input,
				});
			setText("");
		},
	);
	const open = issue.state === "open";
	return (
		<section className="gh-comment-box" aria-label="Add a comment">
			<MarkdownComposer
				label="Add a comment"
				value={text}
				onChange={setText}
				onSubmit={() => void act.run("comment")}
				error={act.error}
				actions={
					<>
						{open ? (
							<>
								<button
									type="button"
									className="pr-button"
									disabled={act.pending}
									onClick={() => void act.run("not_planned")}
								>
									<CircleSlash size={13} aria-hidden="true" />
									Close as not planned
								</button>
								<button
									type="button"
									className="pr-button"
									disabled={act.pending}
									onClick={() => void act.run("completed")}
								>
									<CircleCheck size={13} aria-hidden="true" />
									{text.trim() ? "Close with comment" : "Close issue"}
								</button>
							</>
						) : (
							<button
								type="button"
								className="pr-button"
								disabled={act.pending}
								onClick={() => void act.run("reopen")}
							>
								Reopen issue
							</button>
						)}
						<button
							type="button"
							className="pr-button"
							data-variant="primary"
							disabled={!text.trim() || act.pending}
							onClick={() => void act.run("comment")}
						>
							{act.pending ? "Sending…" : "Comment"}
						</button>
					</>
				}
			/>
		</section>
	);
}

/** Hands the issue to a new chat, which works on it and opens a pull request. */
function StartIssueChat({
	issue,
	projectId,
	harnessId,
	modelId,
	onChatStarted,
}: { issue: IssueDetail } & ChatStart) {
	const start = useServerFn(startIssueChatFn);
	// A retry of the same issue reuses its request id, so it opens one chat.
	const requestId = useRef<string | null>(null);
	const action = useGithubAction(async () => {
		if (!projectId) throw new Error("Select a project before starting a chat.");
		requestId.current ??= crypto.randomUUID();
		const chat = await start({
			data: {
				projectId,
				harnessId: harnessId ?? DEFAULT_COMPOSER_HARNESS_ID,
				modelId: modelId ?? "",
				requestId: requestId.current,
				number: issue.number,
				title: issue.title,
				url: issue.url,
			},
		});
		onChatStarted?.(chat.sessionId);
	});
	if (!projectId || issue.state !== "open") return null;
	return (
		<span className="gh-start-chat">
			<button
				type="button"
				className="pr-button"
				disabled={action.pending}
				onClick={() => void action.run(undefined)}
			>
				{action.pending ? "Starting…" : "Start chat"}
			</button>
			{action.error ? (
				<span className="gh-error" role="alert">
					{action.error}
				</span>
			) : null}
		</span>
	);
}

function NewIssue({
	repository,
	onBack,
	onCreated,
}: {
	repository: GithubRepositoryRef;
	onBack: () => void;
	onCreated: (number: number) => void;
}) {
	const cache = useQueryClient();
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [labels, setLabels] = useState<PullRequestLabel[]>([]);
	const [assignees, setAssignees] = useState<PullRequestPerson[]>([]);
	const create = useGithubAction(async () => {
		const issue = await requestJson<IssueDetail>(API, {
			...repository,
			action: "create",
			title: title.trim(),
			body,
			labels: labels.map((label) => label.name),
			assignees: assignees.map((person) => person.login),
		});
		cache.setQueryData(["issue", repository.repositoryId, issue.number], issue);
		void cache.invalidateQueries({
			queryKey: ["issues", repository.repositoryId],
		});
		onCreated(issue.number);
	});
	return (
		<section className="pr gh-issue" aria-label="New issue">
			<header className="pr-head">
				<div className="pr-head-bar">
					<button type="button" className="pr-ghost" onClick={onBack}>
						<ArrowLeft size={14} />
						Issues
					</button>
				</div>
				<h2 className="pr-title">New issue</h2>
			</header>
			<GithubScrollArea className="pr-pane">
				<form
					className="pr-thread gh-new-issue"
					onSubmit={(event) => {
						event.preventDefault();
						if (title.trim()) void create.run(undefined);
					}}
				>
					<input
						className="gh-input"
						aria-label="Title"
						placeholder="Title"
						value={title}
						maxLength={256}
						// biome-ignore lint/a11y/noAutofocus: the form opened to write a new issue
						autoFocus
						onChange={(event) => setTitle(event.target.value)}
					/>
					<IssueFields
						repository={repository}
						labels={labels}
						assignees={assignees}
						onLabels={setLabels}
						onAssignees={setAssignees}
					/>
					<MarkdownComposer
						label="Description"
						placeholder="Add a description"
						value={body}
						onChange={setBody}
						minRows={8}
						onSubmit={() => {
							if (title.trim()) void create.run(undefined);
						}}
						error={create.error}
						actions={
							<>
								<button type="button" className="pr-button" onClick={onBack}>
									Cancel
								</button>
								<button
									type="submit"
									className="pr-button"
									data-variant="primary"
									disabled={!title.trim() || create.pending}
								>
									{create.pending ? "Creating…" : "Create issue"}
								</button>
							</>
						}
					/>
				</form>
			</GithubScrollArea>
		</section>
	);
}
