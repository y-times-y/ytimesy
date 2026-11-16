import { afterEach, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../github", () => ({
	githubClient: () => github.client,
	repositoryOwnerName: (fullName: string) => {
		const [owner, repo] = fullName.split("/");
		return { owner, repo };
	},
	signedInLogin: async () => "riley",
}));

import { listIssues } from "./issues";

afterEach(() => vi.restoreAllMocks());

const issue = (number: number, extra: Record<string, unknown> = {}) => ({
	number,
	title: `Issue ${number}`,
	html_url: `https://github.com/o/r/issues/${number}`,
	state: "open",
	state_reason: null,
	user: { login: "morgan", avatar_url: null },
	labels: [],
	assignees: [],
	comments: 0,
	created_at: "2026-11-15T00:00:00Z",
	updated_at: "2026-11-15T00:00:00Z",
	...extra,
});

function client(graphql: () => Promise<unknown>) {
	return {
		paginate: async () => [issue(5), issue(6), issue(9, { pull_request: {} })],
		issues: { listForRepo: () => undefined },
		graphql,
	};
}

it("links each open issue to the pull requests that close it", async () => {
	github.client = client(async () => ({
		repository: {
			issues: {
				nodes: [
					{
						number: 5,
						closedByPullRequestsReferences: {
							nodes: [
								{
									number: 12,
									state: "OPEN",
									isDraft: true,
									headRefName: "fix/a",
								},
								{
									number: 13,
									state: "MERGED",
									isDraft: false,
									headRefName: "fix/b",
								},
							],
						},
					},
					{ number: 6, closedByPullRequestsReferences: { nodes: [] } },
				],
			},
		},
	}));
	const rows = await listIssues("t", "o/r", "open");
	expect(rows.map((row) => row.number)).toEqual([5, 6]);
	expect(rows[0].pullRequests).toEqual([
		{ number: 12, state: "draft", head: "fix/a" },
		{ number: 13, state: "merged", head: "fix/b" },
	]);
	expect(rows[1].pullRequests).toBeUndefined();
});

it("still lists the issues when GitHub will not say which pull requests close them", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	github.client = client(async () => {
		throw new Error("denied");
	});
	const rows = await listIssues("t", "o/r", "open");
	expect(rows.map((row) => row.number)).toEqual([5, 6]);
	expect(rows.every((row) => row.pullRequests === undefined)).toBe(true);
});

it("does not read links for closed issues", async () => {
	const graphql = vi.fn(async () => ({}));
	github.client = client(graphql);
	await listIssues("t", "o/r", "closed");
	expect(graphql).not.toHaveBeenCalled();
});
