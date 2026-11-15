import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IssueSummary } from "#/domain/github-issues";
import type { PullRequestDetail } from "#/domain/pull-request-review";
import { IssuesInspector } from "./issues-inspector";
import { PullRequestInspector } from "./pull-request-inspector";

vi.mock("@tanstack/react-start", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-start")>();
	return { ...actual, useServerFn: () => vi.fn() };
});

const ada = { login: "ada", avatarUrl: null, bot: false };
const bob = { login: "bob", avatarUrl: null, bot: false };

const detail: PullRequestDetail = {
	number: 7,
	title: "Add parser",
	body: "Adds the parser.",
	url: "https://github.com/acme/app/pull/7",
	state: "open",
	head: "feature",
	headSha: "a".repeat(40),
	base: "main",
	author: "bob",
	authorAvatarUrl: null,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	mergeable: true,
	mergeableState: "clean",
	additions: 3,
	deletions: 1,
	changedFiles: 1,
	comments: 3,
	checks: [
		{
			name: "web-performance",
			state: "failed",
			url: "https://github.com/acme/app/actions/runs/1/job/2",
			job: { runId: 1, jobId: 2 },
		},
	],
	reviews: [],
	files: [],
	conversation: [
		{
			id: "comment:5",
			databaseId: 5,
			kind: "comment",
			author: ada,
			body: "Mine to edit",
			createdAt: "2026-11-01T01:00:00.000Z",
			url: null,
		},
		{
			id: "inline:10",
			databaseId: 10,
			kind: "inline",
			author: bob,
			body: "Rename this?",
			createdAt: "2026-11-01T02:00:00.000Z",
			url: null,
			path: "src/parser.ts",
			line: 4,
			diffHunk: "@@ -1,2 +1,2 @@\n-old\n+new",
			thread: { id: "PRRT_1", resolved: false },
		},
		{
			id: "inline:11",
			databaseId: 11,
			kind: "inline",
			author: ada,
			body: "Done",
			createdAt: "2026-11-01T03:00:00.000Z",
			url: null,
			path: "src/parser.ts",
			line: 4,
			inReplyTo: 10,
		},
	],
	participants: [bob, ada],
	viewer: "ada",
	labels: [{ name: "bug", color: "d73a4a" }],
	assignees: [ada],
	requestedReviewers: [],
};

function withCache(children: ReactNode, fill: (client: QueryClient) => void) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	fill(client);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>{children}</QueryClientProvider>,
	);
}

describe("pull request panel", () => {
	it("lets the user comment, reply, resolve, review, label and close", () => {
		const html = withCache(
			<PullRequestInspector
				repository={{ installationId: 1, repositoryId: 9, number: 7 }}
			/>,
			(client) => {
				client.setQueryData(["pull-request", 9, 7], detail);
				client.setQueryData(["pull-requests", "open", 9], {
					pullRequests: [],
				});
			},
		);
		expect(html).toContain("Review changes");
		expect(html).toContain("Edit title");
		expect(html).toContain("Reviewers");
		expect(html).toContain("Assignees");
		expect(html).toContain(">bug<");
		expect(html).toContain("Resolve conversation");
		expect(html).toContain(">Reply<");
		// The reply sits inside its thread, not as a separate conversation entry.
		expect(html).toContain("gh-replies");
		expect(html).toContain('aria-label="Comment actions"');
		expect(html).toContain("Close pull request");
		expect(html).toContain('aria-label="Add a comment"');
	});
});

const issue: IssueSummary = {
	number: 42,
	title: "Crash on save",
	url: "https://github.com/acme/app/issues/42",
	state: "open",
	stateReason: null,
	author: ada,
	labels: [{ name: "bug", color: "d73a4a" }],
	assignees: [bob],
	comments: 2,
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
};

describe("issues panel", () => {
	it("lists open issues with a filter row and New issue", () => {
		const html = withCache(
			<IssuesInspector repository={{ installationId: 1, repositoryId: 9 }} />,
			(client) => {
				client.setQueryData(["issues", 9, "open"], { issues: [issue] });
			},
		);
		expect(html).toContain("Crash on save");
		expect(html).toContain("#42");
		expect(html).toContain(">bug<");
		expect(html).toContain("New issue");
		for (const tab of ["Open", "Closed", "All"]) expect(html).toContain(tab);
		expect(html).toContain('aria-selected="true"');
	});

	it("says so when there are no open issues", () => {
		const html = withCache(
			<IssuesInspector repository={{ installationId: 1, repositoryId: 9 }} />,
			(client) => {
				client.setQueryData(["issues", 9, "open"], { issues: [] });
			},
		);
		expect(html).toContain("No open issues.");
	});
});
