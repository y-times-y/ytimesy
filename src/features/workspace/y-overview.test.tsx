import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryPullRequest } from "#/domain/sidebar-pr";
import type { YOverviewThread } from "#/domain/y-overview";

vi.mock("../sessions/agent-session.fn", () => ({
	listProjectAgentSessions: async () => [],
}));

const { YOverview } = await import("./y-overview");

const PROJECT = "project-1";
const NOW = Date.parse("2026-11-12T12:00:00.000Z");

const chats: YOverviewThread[] = [
	{ id: "y2", title: "Y²", role: "y2", turnStatus: "completed" },
	{
		id: "ask",
		title: "Billing page",
		turnStatus: "completed",
		waitingOn: "plan",
		updatedAt: "2026-11-12T11:57:00.000Z",
	},
	{
		id: "run",
		title: "Fix flaky login test",
		turnStatus: "running",
		workingSince: "2026-11-12T11:57:00.000Z",
		updatedAt: "2026-11-12T11:59:59.000Z",
		workingBranch: "fix-login",
	},
];

const pullRequest: RepositoryPullRequest = {
	number: 8357,
	url: "https://github.com/acme/web/pull/8357",
	head: "fix-login",
	base: "main",
	title: "Stabilize login test",
	draft: false,
	state: "open",
	merged: false,
	mergeable: true,
	mergeableState: "clean",
	additions: 42,
	deletions: 7,
	installationId: 1,
	repositoryId: 2,
	repositoryFullName: "acme/web",
};

function render(
	listed: readonly YOverviewThread[],
	prs = [pullRequest],
	labelPrefix?: string,
) {
	const client = new QueryClient();
	client.setQueryData(["agent-sessions", PROJECT], listed);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<YOverview
				projectId={PROJECT}
				pullRequests={prs}
				live={false}
				renderedAtMs={NOW}
				labelPrefix={labelPrefix}
				onOpenThread={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

describe("YOverview", () => {
	it("groups the sidebar's threads into Needs you, In progress and Pull requests", () => {
		const html = render(chats);
		expect(html).toMatch(/Needs you<\/span><span class="y-overview-count">1</);
		expect(html).toMatch(
			/In progress<\/span><span class="y-overview-count">1</,
		);
		expect(html).toMatch(
			/Pull requests<\/span><span class="y-overview-count">1</,
		);
		expect(html).toContain("waiting on your plan approval");
		expect(html).toContain("running 3m");
		expect(html).toContain("web#8357");
		expect(html).toMatch(
			/main<svg[^<]*aria-label="from"[\s\S]*?<\/svg>fix-login/,
		);
		expect(html).toContain("+42");
		expect(html).toContain("−7");
		expect(html).toContain("via Fix flaky login test");
		expect(html).not.toContain(">Y²<");
	});

	it("says so quietly when nothing needs the person and nothing runs", () => {
		const html = render([chats[0] as YOverviewThread], []);
		expect(html).toContain("Nothing needs you. No threads running.");
		expect(html).not.toContain("y-overview-group");
	});

	it("shows each thread's short id on its rows and in 'via <id>' on pull request rows", () => {
		const hexChats: YOverviewThread[] = [
			{
				...(chats[1] as YOverviewThread),
				id: "3f9a0000-0000-4000-8000-000000000001",
			},
			{
				...(chats[2] as YOverviewThread),
				id: "00c40000-0000-4000-8000-000000000002",
			},
		];
		const html = render(hexChats, [pullRequest], "WEB");
		expect(html).toMatch(
			/y-overview-id">WEB-3F9A<\/span>[^<]*<span[^>]*>·<\/span>waiting on your plan approval/,
		);
		expect(html).toMatch(
			/y-overview-id">WEB-00C4<\/span>[^<]*<span[^>]*>·<\/span>running 3m/,
		);
		expect(html).toContain("via WEB-00C4");
		expect(html).not.toContain("via Fix flaky login test");
		// Without a prefix the rows are as before.
		expect(render(hexChats)).not.toContain("y-overview-id");
	});
});
