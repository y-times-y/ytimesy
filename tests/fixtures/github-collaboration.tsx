/** Browser fixture: real components, explicitly simulated GitHub responses. Never uses credentials. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IssueDetail } from "../../src/domain/github-issues";
import type {
	PullRequestDetail,
	RepositoryPullRequest,
} from "../../src/domain/pull-request-review";
import { IssuesInspector } from "../../src/features/workspace/issues-inspector";
import { PullRequestInspector } from "../../src/features/workspace/pull-request-inspector";
import {
	type WorkItemsKind,
	WorkItemsPage,
} from "../../src/features/workspace/work-items-page";
import "../../src/styles.css";

const author = { login: "morgan", avatarUrl: null, bot: false };
const reviewer = { login: "jules", avatarUrl: null, bot: false };
const viewer = { login: "riley", avatarUrl: null, bot: false };
const date = "2026-11-15T00:00:00Z";
const repository = { installationId: 11, repositoryId: 22 };
const labels = [
	{ name: "bug", color: "b84c5a" },
	{ name: "enhancement", color: "3065a2" },
];
let pull: PullRequestDetail = {
	number: 74,
	title: "Keep editor selections when switching files",
	body: "## What changed\nSelections now stay with each file.\n\n- Preserve the cursor position\n- Restore selection when a file reopens",
	url: "https://github.com/example/editor/pull/74",
	state: "open",
	head: "fix/editor-selection",
	base: "main",
	headSha: "a".repeat(40),
	author: author.login,
	authorAvatarUrl: null,
	createdAt: date,
	updatedAt: date,
	mergeable: true,
	mergeableState: "clean",
	additions: 8,
	deletions: 2,
	changedFiles: 1,
	comments: 2,
	checks: [
		{
			name: "unit-tests",
			state: "passed",
			url: null,
			job: { runId: 4, jobId: 5 },
		},
		{
			name: "browser-checks",
			state: "failed",
			url: null,
			job: { runId: 4, jobId: 6 },
		},
	],
	reviews: [],
	files: [
		{
			path: "src/editor.ts",
			change: "update",
			additions: 1,
			deletions: 1,
			preview:
				"--- a/src/editor.ts\n+++ b/src/editor.ts\n@@ -1,3 +1,3 @@\n export function restore() {\n-  return null;\n+  return selection;\n }\n",
		},
	],
	conversation: [
		{
			id: "inline:8",
			databaseId: 8,
			kind: "inline",
			author,
			body: "Could we preserve the anchor too?",
			createdAt: date,
			url: null,
			path: "src/editor.ts",
			line: 2,
			side: "RIGHT",
			thread: { id: "PRRT_fixture", resolved: false },
			diffHunk: "@@ -1,3 +1,3 @@\n-  return null;\n+  return selection;",
		},
		{
			id: "comment:9",
			databaseId: 9,
			kind: "comment",
			author: viewer,
			body: "I will check the keyboard path.",
			createdAt: date,
			url: null,
		},
	],
	participants: [author, viewer],
	viewer: viewer.login,
	labels: [labels[0]],
	assignees: [viewer],
	requestedReviewers: [],
};
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const issues: Mutable<IssueDetail>[] = [
	{
		number: 39,
		title: "Selection disappears on file switch",
		body: "Switch between two open files. The cursor should stay where you left it.",
		url: "https://github.com/example/editor/issues/39",
		state: "open",
		stateReason: null,
		author,
		labels: [labels[0]],
		assignees: [viewer],
		comments: 1,
		createdAt: date,
		updatedAt: date,
		conversation: [
			{
				id: 2,
				author: viewer,
				body: "Reproduced with a multi-line selection.",
				createdAt: date,
				url: null,
			},
		],
		linkedPullRequests: [
			{ number: 74, title: pull.title, url: pull.url, state: "open" },
		],
		viewer: viewer.login,
	},
];
const calls: Record<string, unknown>[] = [];
let nextFailure: string | null = null;
Object.assign(window, {
	githubFixtureCalls: calls,
	githubFixtureRefuseNext: (message: string) => {
		nextFailure = message;
	},
});
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
		location.origin,
	);
	if (!url.pathname.startsWith("/api/github/"))
		return originalFetch(input, init);
	const isIssue = url.pathname.endsWith("/issue");
	// A second connected repository (the sidebar pages) has its own, smaller lists.
	const second = url.searchParams.get("repositoryId") === "23";
	const data = init?.body ? JSON.parse(String(init.body)) : null;
	if (data) {
		if (nextFailure) {
			const error = nextFailure;
			nextFailure = null;
			return Response.json({ error }, { status: 403 });
		}
		calls.push(data);
		if (isIssue) {
			if (data.action === "create") {
				const number = 40 + issues.length;
				issues.push({
					...issues[0],
					...data,
					number,
					url: `https://github.com/example/editor/issues/${number}`,
					author: viewer,
					labels: labels.filter((label) => data.labels.includes(label.name)),
					assignees: [viewer],
					conversation: [],
					comments: 0,
					linkedPullRequests: [],
				});
				return Response.json(issues.at(-1));
			}
			const issue = issues.find((issue) => issue.number === data.number);
			if (!issue)
				return Response.json({ error: "Issue not found" }, { status: 404 });
			if (data.action === "edit") {
				issue.title = data.title ?? issue.title;
				issue.body = data.body ?? issue.body;
			}
			if (data.action === "state") {
				issue.state = data.state;
				issue.stateReason = data.reason ?? null;
			}
			if (data.action === "comment") {
				issue.conversation = [
					...issue.conversation,
					{
						id: Date.now(),
						author: viewer,
						body: data.body,
						createdAt: date,
						url: null,
					},
				];
				issue.comments += 1;
			}
			if (data.action === "labels")
				issue.labels = labels.filter((label) =>
					data.labels.includes(label.name),
				);
			if (data.action === "assignees")
				issue.assignees = data.add.length ? [author] : [];
			if (data.action === "edit-comment")
				issue.conversation = issue.conversation.map((comment) =>
					comment.id === data.commentId
						? { ...comment, body: data.body }
						: comment,
				);
			if (data.action === "delete-comment")
				issue.conversation = issue.conversation.filter(
					(comment) => comment.id !== data.commentId,
				);
			return Response.json(issue);
		}
		if (data.action === "edit")
			pull = {
				...pull,
				title: data.title ?? pull.title,
				body: data.body ?? pull.body,
			};
		if (data.action === "state") pull = { ...pull, state: data.state };
		if (
			data.action === "comment" ||
			data.action === "line-comment" ||
			data.action === "reply"
		)
			pull = {
				...pull,
				conversation: [
					...pull.conversation,
					{
						id: `comment:${Date.now()}`,
						databaseId: Date.now(),
						kind: data.action === "comment" ? "comment" : "inline",
						author: viewer,
						body: data.body,
						createdAt: date,
						url: null,
						path: data.path,
						line: data.line,
						side: data.side,
						inReplyTo: data.action === "reply" ? data.commentId : null,
					},
				],
			};
		if (data.action === "resolve-thread")
			pull = {
				...pull,
				conversation: pull.conversation.map((comment) =>
					comment.thread?.id === data.threadId
						? {
								...comment,
								thread: { id: data.threadId, resolved: Boolean(data.resolved) },
							}
						: comment,
				),
			};
		if (data.action === "review")
			pull = {
				...pull,
				reviews: [
					...pull.reviews,
					{
						author: viewer.login,
						state:
							data.event === "APPROVE"
								? "APPROVED"
								: data.event === "REQUEST_CHANGES"
									? "CHANGES_REQUESTED"
									: "COMMENTED",
						submittedAt: date,
					},
				],
			};
		if (data.action === "labels")
			pull = {
				...pull,
				labels: labels.filter((label) => data.labels.includes(label.name)),
			};
		if (data.action === "reviewers")
			pull = { ...pull, requestedReviewers: data.add.length ? [viewer] : [] };
		if (data.action === "assignees")
			pull = { ...pull, assignees: data.add.length ? [author] : [] };
		if (data.action === "rerun")
			pull = {
				...pull,
				checks: pull.checks.map((check) => ({ ...check, state: "pending" })),
			};
		if (data.action === "edit-comment")
			pull = {
				...pull,
				conversation: pull.conversation.map((comment) =>
					comment.databaseId === data.commentId
						? { ...comment, body: data.body }
						: comment,
				),
			};
		if (data.action === "delete-comment")
			pull = {
				...pull,
				conversation: pull.conversation.filter(
					(comment) => comment.databaseId !== data.commentId,
				),
			};
		return Response.json(pull);
	}
	if (url.searchParams.has("choices"))
		return Response.json({ labels, people: [author, viewer] });
	if (url.searchParams.has("jobId"))
		return Response.json({
			log: "Run browser checks\nFAIL selection.spec.ts: expected selection anchor to persist\n2 passed, 1 failed",
		});
	if (isIssue) {
		if (url.searchParams.has("number"))
			return Response.json(
				issues.find(
					(issue) => issue.number === Number(url.searchParams.get("number")),
				),
			);
		const state = url.searchParams.get("state");
		return Response.json({
			issues: issues
				.filter((issue) => state === "all" || issue.state === state)
				.slice(0, second ? 2 : undefined)
				.map((issue) =>
					second
						? {
								...issue,
								title: `[docs] ${issue.title}`,
								number: issue.number + 100,
							}
						: issue,
				),
		});
	}
	if (url.searchParams.has("number")) return Response.json(pull);
	const state = url.searchParams.get("state") ?? "open";
	const rows: RepositoryPullRequest[] = Array.from(
		{ length: 18 },
		(_, index) => ({
			...pull,
			number: index ? 74 - index : pull.number,
			title: index
				? [
						"Reduce background polling while idle",
						"Restore terminal output after reconnect",
						"Improve repository search on mobile",
					][index % 3]
				: pull.title,
			author: author.login,
			authorName: null,
			authorAvatarUrl: null,
			draft: index % 5 === 2,
			state: index % 5 === 2 ? "draft" : "open",
			labels: [labels[index % 2]],
			head: index % 4 === 1 ? "ytimesy/polling" : `feature/row-${index}`,
			checks: [
				{ passed: 8, failed: 0, pending: 0 },
				{ passed: 5, failed: 2, pending: 1 },
				{ passed: 3, failed: 0, pending: 4 },
				null,
			][index % 4],
			review: [
				{ kind: "approved", by: reviewer },
				{ kind: "requested", from: reviewer, you: true },
				{ kind: "changes", by: reviewer },
				{ kind: "requested", from: reviewer, you: false },
				null,
			][index % 5] as RepositoryPullRequest["review"],
			additions: 12 + index * 17,
			deletions: index * 5,
		}),
	);
	return Response.json({
		pullRequests:
			state === "open" || state === "all"
				? second
					? rows.slice(0, 3).map((row) => ({
							...row,
							title: `[docs] ${row.title}`,
							number: row.number + 100,
							head: `docs/${row.head}`,
						}))
					: rows
				: [],
	});
};
const client = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function Fixture() {
	const [view, setView] = useState<"pr" | "issues" | WorkItemsKind>("pr");
	const [number, setNumber] = useState<number>();
	return (
		<QueryClientProvider client={client}>
			<div className="qa-shell">
				<nav className="qa-nav">
					<strong>example / editor</strong>
					<button
						type="button"
						onClick={() => {
							setNumber(undefined);
							setView("pr");
						}}
					>
						Pull requests
					</button>
					<button type="button" onClick={() => setView("issues")}>
						Issues
					</button>
					<button type="button" onClick={() => setView("pull-requests")}>
						Pages: pull requests
					</button>
					<button type="button" onClick={() => setView("issues-all" as never)}>
						Pages: issues
					</button>
					<small>Component test · simulated GitHub</small>
				</nav>
				<main className="qa-surface">
					{view === "pull-requests" || (view as string) === "issues-all" ? (
						<WorkItemsPage
							key={view}
							kind={view === "pull-requests" ? "pull-requests" : "issues"}
							repositories={[
								{ ...repository, name: "editor", projectId: "p1" },
								{
									installationId: 11,
									repositoryId: 23,
									name: "docs",
									projectId: "p2",
								},
							]}
							chatsOf={(repositoryId) =>
								repositoryId === 22
									? new Map([
											[
												"ytimesy/polling",
												{ id: "c1", title: "Polling fix", working: true },
											],
										])
									: new Map()
							}
							onOpenChat={() => undefined}
							onChatStarted={() => undefined}
						/>
					) : view === "pr" ? (
						<PullRequestInspector
							key={number ?? "list"}
							repository={{ ...repository, number }}
							pullRequestChats={
								new Map([
									[
										"ytimesy/polling",
										{ id: "c1", title: "Polling fix", working: true },
									],
									[
										"feature/row-2",
										{ id: "c2", title: "Terminal reconnect", working: false },
									],
								])
							}
						/>
					) : (
						<IssuesInspector
							repository={repository}
							onOpenPullRequest={(number) => {
								setNumber(number);
								setView("pr");
							}}
						/>
					)}
				</main>
				<footer className="qa-status">
					Real ytimesy components · no GitHub writes or agent runs
				</footer>
			</div>
		</QueryClientProvider>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
