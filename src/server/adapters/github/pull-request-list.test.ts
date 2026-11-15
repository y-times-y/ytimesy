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

import { listRepositoryPullRequests } from "./pull-request-list";

afterEach(() => vi.restoreAllMocks());

const pull = {
	number: 7,
	title: "Fix",
	html_url: "u",
	user: { login: "morgan", avatar_url: null },
	draft: false,
	state: "open",
	merged_at: null,
	head: { ref: "feature" },
	base: { ref: "main" },
	updated_at: "2026-11-15T00:00:00Z",
	labels: [],
};

function client(graphql: (query: string) => Promise<unknown>) {
	const listForRef = vi.fn(async () => ({
		data: {
			check_runs: [
				{ status: "completed", conclusion: "success" },
				{ status: "completed", conclusion: "failure" },
				{ status: "in_progress", conclusion: null },
			],
		},
	}));
	return {
		paginate: async () => [pull],
		pulls: { list: () => undefined },
		graphql,
		rest: {
			checks: { listForRef },
			repos: {
				getCombinedStatusForRef: async () => ({
					data: { statuses: [{ state: "success" }] },
				}),
			},
		},
		listForRef,
	};
}

const base = {
	repository: {
		pullRequests: {
			nodes: [
				{
					number: 7,
					additions: 3,
					deletions: 1,
					headRefOid: "abc",
					latestOpinionatedReviews: { nodes: [] },
					reviewRequests: { nodes: [] },
				},
			],
			pageInfo: { hasNextPage: false, endCursor: null },
		},
	},
};

it("keeps review and size when the check rollup is refused, and reads checks over REST", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const fake = client(async (query) => {
		if (query.includes("statusCheckRollup")) throw new Error("denied");
		return base;
	});
	github.client = fake;
	const [row] = await listRepositoryPullRequests("t", "o/r", "open");
	expect(row.additions).toBe(3);
	expect(row.checks).toEqual({ passed: 2, failed: 1, pending: 1 });
	expect(fake.listForRef).toHaveBeenCalledWith(
		expect.objectContaining({ ref: "abc" }),
	);
});

it("uses the rollup when GitHub gives one and makes no REST calls", async () => {
	const fake = client(async (query) =>
		query.includes("statusCheckRollup")
			? {
					repository: {
						pullRequests: {
							nodes: [
								{
									number: 7,
									commits: {
										nodes: [
											{
												commit: {
													statusCheckRollup: {
														contexts: {
															nodes: [
																{
																	__typename: "CheckRun",
																	status: "COMPLETED",
																	conclusion: "SUCCESS",
																},
															],
														},
													},
												},
											},
										],
									},
								},
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				}
			: base,
	);
	github.client = fake;
	const [row] = await listRepositoryPullRequests("t", "o/r", "open");
	expect(row.checks).toEqual({ passed: 1, failed: 0, pending: 0 });
	expect(fake.listForRef).not.toHaveBeenCalled();
});
