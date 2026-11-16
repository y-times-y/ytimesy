import { ArrowLeft, Check, ChevronDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Suspense, useState } from "react";
import type { AgentProviderId } from "#/domain/agent-provider";
import { chatForIssue } from "#/domain/github-issues";
import { IssueList, IssuePage, NewIssue } from "./issues-inspector";
import { PullRequestInspector } from "./pull-request-inspector";
import { PullRequestList, type WorkRepository } from "./pull-request-list";
import type { PullRequestChat } from "./pull-request-marks";
import "./pull-request-inspector.css";
import "./work-items-page.css";

export type WorkItemsKind = "pull-requests" | "issues";

type Screen =
	| { readonly kind: "list" }
	| {
			readonly kind: "pull-request";
			readonly repository: WorkRepository;
			readonly number: number;
	  }
	| {
			readonly kind: "issue";
			readonly repository: WorkRepository;
			readonly number: number;
			readonly chat?: PullRequestChat;
	  }
	| { readonly kind: "new-issue"; readonly repository: WorkRepository };

const ALL = "all";

/** The repository filter: every connected repository, or one. */
function RepositoryFilter({
	repositories,
	value,
	onChange,
}: {
	repositories: readonly WorkRepository[];
	value: string;
	onChange: (value: string) => void;
}) {
	const current = repositories.find(
		(repository) => String(repository.repositoryId) === value,
	);
	return (
		<DropdownMenu.Root modal={false}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					className="work-repo-filter"
					aria-label="Filter by repository"
				>
					{current ? current.name : "All repos"}
					<ChevronDown size={14} aria-hidden="true" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="pr-picker-menu work-repo-menu"
					align="end"
					sideOffset={6}
				>
					{[
						{ id: ALL, name: "All repos" },
						...repositories.map((repository) => ({
							id: String(repository.repositoryId),
							name: repository.name,
						})),
					].map((item) => (
						<DropdownMenu.Item
							key={item.id}
							className="pr-picker-item"
							onSelect={() => onChange(item.id)}
						>
							<span>{item.name}</span>
							{item.id === value ? <Check size={14} /> : null}
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/**
 * Pull requests or Issues across every repository connected to a project, from
 * the left sidebar: one table, a repository filter, and the in-app review or
 * issue page when a row opens.
 */
export function WorkItemsPage({
	kind,
	repositories,
	chatsOf,
	issueChatsOf,
	onOpenChat,
	harnessId,
	modelId,
	currentSessionId,
	onChatStarted,
}: {
	kind: WorkItemsKind;
	repositories: readonly WorkRepository[];
	/** The chat working on each pull request of a repository, by its head branch. */
	chatsOf: (repositoryId: number) => ReadonlyMap<string, PullRequestChat>;
	/** The chat started for each issue of a repository, by issue number. */
	issueChatsOf: (repositoryId: number) => ReadonlyMap<number, PullRequestChat>;
	onOpenChat: (chatId: string) => void;
	harnessId?: AgentProviderId;
	modelId?: string;
	currentSessionId?: string;
	/** A chat the page started (a review, an issue): open it. */
	onChatStarted: (sessionId: string, projectId?: string) => void;
}) {
	const [repoId, setRepoId] = useState(ALL);
	const [screen, setScreen] = useState<Screen>({ kind: "list" });
	const [issueFilter, setIssueFilter] = useState<"open" | "closed" | "all">(
		"open",
	);
	const shown =
		repoId === ALL
			? repositories
			: repositories.filter(
					(repository) => String(repository.repositoryId) === repoId,
				);
	const title = kind === "pull-requests" ? "Pull requests" : "Issues";
	const back = () => setScreen({ kind: "list" });
	const toolbar =
		repositories.length > 1 ? (
			<RepositoryFilter
				repositories={repositories}
				value={repoId}
				onChange={setRepoId}
			/>
		) : null;
	return (
		<section className="work-page" aria-label={title}>
			<header className="work-page-header">
				{screen.kind === "list" || screen.kind === "pull-request" ? (
					<h1>{title}</h1>
				) : (
					<button type="button" className="work-back" onClick={back}>
						<ArrowLeft size={14} aria-hidden="true" />
						{title}
					</button>
				)}
				{screen.kind !== "list" && "repository" in screen ? (
					<span className="work-page-repo">{screen.repository.name}</span>
				) : null}
			</header>
			<div className="work-page-body">
				{!repositories.length ? (
					<p className="pr-empty">
						Connect a repository to a project to see its {title.toLowerCase()}{" "}
						here.
					</p>
				) : screen.kind === "pull-request" ? (
					<Suspense fallback={<p className="pr-empty">Loading…</p>}>
						<PullRequestInspector
							key={`${screen.repository.repositoryId}:${screen.number}`}
							repository={{
								installationId: screen.repository.installationId,
								repositoryId: screen.repository.repositoryId,
								number: screen.number,
							}}
							projectId={screen.repository.projectId}
							harnessId={harnessId}
							modelId={modelId}
							currentSessionId={currentSessionId}
							onBack={back}
							onReviewStarted={(sessionId) =>
								onChatStarted(sessionId, screen.repository.projectId)
							}
							pullRequestChats={chatsOf(screen.repository.repositoryId)}
							onOpenChat={onOpenChat}
						/>
					</Suspense>
				) : screen.kind === "issue" ? (
					<IssuePage
						key={`${screen.repository.repositoryId}:${screen.number}`}
						repository={screen.repository}
						number={screen.number}
						onBack={back}
						projectId={screen.repository.projectId}
						harnessId={harnessId}
						modelId={modelId}
						chat={screen.chat}
						onOpenChat={onOpenChat}
						onChatStarted={(sessionId) =>
							onChatStarted(sessionId, screen.repository.projectId)
						}
						onOpenPullRequest={(number) =>
							setScreen({
								kind: "pull-request",
								repository: screen.repository,
								number,
							})
						}
					/>
				) : screen.kind === "new-issue" ? (
					<NewIssue
						repository={screen.repository}
						onBack={back}
						onCreated={(number) =>
							setScreen({
								kind: "issue",
								repository: screen.repository,
								number,
							})
						}
					/>
				) : kind === "pull-requests" ? (
					<PullRequestList
						repositories={shown}
						showRepository
						toolbar={toolbar}
						chatFor={(repository, head) =>
							chatsOf(repository.repositoryId).get(head)
						}
						onOpenChat={onOpenChat}
						onOpen={(pull, repository) =>
							setScreen({
								kind: "pull-request",
								repository: repository,
								number: pull.number,
							})
						}
					/>
				) : (
					<IssueList
						repositories={shown}
						showRepository
						toolbar={toolbar}
						filter={issueFilter}
						onFilter={setIssueFilter}
						chatFor={(repository, issue) =>
							chatForIssue({
								pullRequests: issue.pullRequests,
								byHead: chatsOf(repository.repositoryId),
								byIssue: issueChatsOf(repository.repositoryId),
								number: issue.number,
							})
						}
						onOpenChat={onOpenChat}
						onOpenPullRequest={(number, repository) =>
							setScreen({ kind: "pull-request", repository, number })
						}
						onOpen={(number, repository, chat) =>
							setScreen({ kind: "issue", repository, number, chat })
						}
						onNew={() => setScreen({ kind: "new-issue", repository: shown[0] })}
					/>
				)}
			</div>
		</section>
	);
}
