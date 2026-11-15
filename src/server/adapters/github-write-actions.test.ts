import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueDetail, listIssues, runIssueAction } from "./github/issues";
import {
	actionsJobLog,
	runPullRequestAction,
} from "./github/pull-request-actions";
import { listRepositoryPullRequests } from "./github/pull-request-list";

const api = vi.hoisted(() => ({
	createComment: vi.fn(),
	updateComment: vi.fn(),
	deleteComment: vi.fn(),
	createReplyForReviewComment: vi.fn(),
	updateReviewComment: vi.fn(),
	deleteReviewComment: vi.fn(),
	createReview: vi.fn(),
	createReviewComment: vi.fn(),
	pullsUpdate: vi.fn(),
	requestReviewers: vi.fn(),
	removeRequestedReviewers: vi.fn(),
	setLabels: vi.fn(),
	addAssignees: vi.fn(),
	removeAssignees: vi.fn(),
	reRunJob: vi.fn(),
	reRunFailed: vi.fn(),
	downloadJobLogs: vi.fn(),
	graphql: vi.fn(),
	listForRepo: vi.fn(),
	issuesGet: vi.fn(),
	issuesCreate: vi.fn(),
	issuesUpdate: vi.fn(),
	listComments: vi.fn(),
	paginate: vi.fn(),
	getAuthenticated: vi.fn(),
	getComment: vi.fn(),
	getReviewComment: vi.fn(),
	pullsList: vi.fn(),
}));
vi.mock("@octokit/rest", () => ({
	Octokit: class {
		issues = {
			getComment: api.getComment,
			createComment: api.createComment,
			updateComment: api.updateComment,
			deleteComment: api.deleteComment,
			setLabels: api.setLabels,
			addAssignees: api.addAssignees,
			removeAssignees: api.removeAssignees,
			listForRepo: api.listForRepo,
			get: api.issuesGet,
			create: api.issuesCreate,
			update: api.issuesUpdate,
			listComments: api.listComments,
		};
		pulls = {
			getReviewComment: api.getReviewComment,
			list: api.pullsList,
			createReplyForReviewComment: api.createReplyForReviewComment,
			updateReviewComment: api.updateReviewComment,
			deleteReviewComment: api.deleteReviewComment,
			createReview: api.createReview,
			createReviewComment: api.createReviewComment,
			update: api.pullsUpdate,
			requestReviewers: api.requestReviewers,
			removeRequestedReviewers: api.removeRequestedReviewers,
		};
		actions = {
			reRunJobForWorkflowRun: api.reRunJob,
			reRunWorkflowFailedJobs: api.reRunFailed,
			downloadJobLogsForWorkflowRun: api.downloadJobLogs,
		};
		users = { getAuthenticated: api.getAuthenticated };
		graphql = api.graphql;
		paginate = api.paginate;
	},
}));
vi.mock("../config", () => {
	const serverConfig = () => ({ GITHUB_APP_SLUG: "ytimesy" });
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});

const target = { owner: "acme", repo: "app" };
const sha = "b".repeat(40);

beforeEach(() => {
	vi.resetAllMocks();
	for (const fn of Object.values(api)) fn.mockResolvedValue({ data: {} });
});

describe("pull request changes", () => {
	it("posts a comment, a reply and a review as the signed-in user", async () => {
		await runPullRequestAction("token", "acme/app", 7, {
			action: "comment",
			body: "Nice",
		});
		expect(api.createComment).toHaveBeenCalledWith({
			...target,
			issue_number: 7,
			body: "Nice",
		});
		await runPullRequestAction("token", "acme/app", 7, {
			action: "reply",
			commentId: 11,
			body: "Fixed",
		});
		expect(api.createReplyForReviewComment).toHaveBeenCalledWith({
			...target,
			pull_number: 7,
			comment_id: 11,
			body: "Fixed",
		});
		await runPullRequestAction("token", "acme/app", 7, {
			action: "review",
			event: "APPROVE",
			body: "",
			headSha: sha,
			comments: [{ path: "a.ts", line: 2, side: "RIGHT", body: "nit" }],
		});
		expect(api.createReview).toHaveBeenCalledWith({
			...target,
			pull_number: 7,
			commit_id: sha,
			event: "APPROVE",
			comments: [{ path: "a.ts", line: 2, side: "RIGHT", body: "nit" }],
		});
	});

	it("resolves a thread through GraphQL and re-runs failed jobs", async () => {
		api.graphql.mockResolvedValueOnce({
			node: {
				pullRequest: { number: 7, repository: { nameWithOwner: "acme/app" } },
			},
		});
		await runPullRequestAction("token", "acme/app", 7, {
			action: "resolve-thread",
			threadId: "PRRT_1",
			resolved: true,
		});
		expect(api.graphql.mock.calls[1][0]).toContain("resolveReviewThread");
		expect(api.graphql.mock.calls[1][1]).toEqual({ id: "PRRT_1" });
		await runPullRequestAction("token", "acme/app", 7, {
			action: "rerun",
			target: { failedInRunId: 99 },
		});
		expect(api.reRunFailed).toHaveBeenCalledWith({ ...target, run_id: 99 });
	});

	it("changes reviewers and assignees with only the calls needed", async () => {
		await runPullRequestAction("token", "acme/app", 7, {
			action: "reviewers",
			add: ["ada"],
			remove: [],
		});
		expect(api.requestReviewers).toHaveBeenCalledWith({
			...target,
			pull_number: 7,
			reviewers: ["ada"],
		});
		expect(api.removeRequestedReviewers).not.toHaveBeenCalled();
		await runPullRequestAction("token", "acme/app", 7, {
			action: "assignees",
			add: [],
			remove: ["bob"],
		});
		expect(api.removeAssignees).toHaveBeenCalledWith({
			...target,
			issue_number: 7,
			assignees: ["bob"],
		});
		expect(api.addAssignees).not.toHaveBeenCalled();
	});

	it("explains a missing GitHub App permission instead of 'reconnect GitHub'", async () => {
		api.reRunJob.mockRejectedValue(
			Object.assign(new Error("Resource not accessible by integration"), {
				status: 403,
			}),
		);
		const refusal = await runPullRequestAction("token", "acme/app", 7, {
			action: "rerun",
			target: { jobId: 5 },
		}).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(Response);
		const response = refusal as Response;
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: string }).error).toContain(
			'"Actions: write"',
		);
	});

	it("returns the full job log", async () => {
		api.downloadJobLogs.mockResolvedValue({
			data: "2026-11-14T00:00:00Z step 1\n2026-11-14T00:00:01Z FAIL test",
		});
		expect(await actionsJobLog("token", "acme/app", 5)).toEqual({
			log: "2026-11-14T00:00:00Z step 1\n2026-11-14T00:00:01Z FAIL test",
		});
	});
});

it("decodes binary job-log downloads instead of displaying an object name", async () => {
	api.downloadJobLogs.mockResolvedValue({
		data: new TextEncoder().encode("Step one\nFailure: focus lost").buffer,
	});
	expect(await actionsJobLog("token", "meridian/console", 81)).toEqual({
		log: "Step one\nFailure: focus lost",
	});
});

it("lists all PR states without mixing merged and closed, through pagination", async () => {
	const row = {
		number: 93,
		title: "Track keyboard focus",
		html_url: "https://github.com/meridian/console/pull/93",
		user: { login: "sasha" },
		state: "closed",
		draft: false,
		head: { ref: "fix/focus" },
		base: { ref: "trunk" },
		updated_at: "2026-11-15T00:00:00Z",
		labels: [],
	};
	api.paginate.mockResolvedValue([
		{ ...row, merged_at: "2026-11-15T00:00:00Z" },
		{ ...row, number: 94, merged_at: null },
	]);
	expect(
		(
			await listRepositoryPullRequests("token", "meridian/console", "merged")
		).map((pull) => pull.number),
	).toEqual([93]);
	expect(
		(
			await listRepositoryPullRequests("token", "meridian/console", "closed")
		).map((pull) => pull.number),
	).toEqual([94]);
	expect(api.paginate).toHaveBeenCalledWith(
		api.pullsList,
		expect.objectContaining({
			owner: "meridian",
			repo: "console",
			state: "closed",
			per_page: 100,
		}),
	);
	expect(
		(await listRepositoryPullRequests("token", "meridian/console", "all")).map(
			(pull) => pull.state,
		),
	).toEqual(["merged", "closed"]);
});

const issue = {
	number: 4,
	title: "Crash on save",
	html_url: "https://github.com/acme/app/issues/4",
	state: "open",
	state_reason: null,
	user: { login: "ada", avatar_url: null, type: "User" },
	labels: [{ name: "bug", color: "d73a4a", description: "Broken" }, "plain"],
	assignees: [],
	comments: 1,
	created_at: "2026-11-01T00:00:00Z",
	updated_at: "2026-11-02T00:00:00Z",
	body: "Steps…",
};

it("refuses a thread from another repository or PR before mutation", async () => {
	for (const target of [
		{ number: 8, repository: { nameWithOwner: "acme/app" } },
		{ number: 7, repository: { nameWithOwner: "other/app" } },
	]) {
		api.graphql.mockResolvedValueOnce({ node: { pullRequest: target } });
		await expect(
			runPullRequestAction("token", "acme/app", 7, {
				action: "resolve-thread",
				threadId: "PRRT_other",
				resolved: true,
			}),
		).rejects.toMatchObject({ status: 404 });
	}
	expect(api.graphql).toHaveBeenCalledTimes(2);
});

it("edits only a comment belonging to the selected item", async () => {
	api.getComment.mockResolvedValue({
		data: { issue_url: "https://api.github.com/repos/acme/app/issues/7" },
	});
	await runPullRequestAction("token", "acme/app", 7, {
		action: "edit-comment",
		kind: "comment",
		commentId: 31,
		body: "Updated",
	});
	expect(api.updateComment).toHaveBeenCalledWith({
		...target,
		comment_id: 31,
		body: "Updated",
	});
	api.updateComment.mockClear();
	await expect(
		runIssueAction("token", "acme/app", {
			action: "edit-comment",
			number: 8,
			commentId: 31,
			body: "Wrong issue",
		}),
	).rejects.toMatchObject({ status: 404 });
	expect(api.updateComment).not.toHaveBeenCalled();
});

describe("issues", () => {
	it("lists issues without the pull requests GitHub mixes in", async () => {
		api.paginate.mockResolvedValue([
			issue,
			{ ...issue, number: 5, pull_request: { url: "x" } },
		]);
		const listed = await listIssues("token", "acme/app", "open");
		expect(listed.map((item) => item.number)).toEqual([4]);
		expect(listed[0].labels).toEqual([
			{ name: "bug", color: "d73a4a", description: "Broken" },
			{ name: "plain", color: "777777", description: null },
		]);
	});

	it("reads an issue with its comments and the pull requests that close it", async () => {
		api.issuesGet.mockResolvedValue({ data: issue });
		api.paginate.mockResolvedValue([
			{
				id: 31,
				user: { login: "bob" },
				body: "Same here",
				created_at: "2026-11-01T02:00:00Z",
				html_url: "u",
			},
		]);
		api.graphql.mockResolvedValue({
			repository: {
				issue: {
					closedByPullRequestsReferences: {
						nodes: [{ number: 9, title: "Fix", url: "p", state: "MERGED" }],
					},
				},
			},
		});
		api.getAuthenticated.mockResolvedValue({ data: { login: "ada" } });
		const detail = await issueDetail("token", "acme/app", 4);
		expect(detail.conversation.map((comment) => comment.id)).toEqual([31]);
		expect(detail.linkedPullRequests).toEqual([
			{ number: 9, title: "Fix", url: "p", state: "merged" },
		]);
		expect(detail.viewer).toBe("ada");
	});

	it("creates an issue and closes one with GitHub's reason", async () => {
		api.issuesCreate.mockResolvedValue({ data: { number: 12 } });
		expect(
			await runIssueAction("token", "acme/app", {
				action: "create",
				title: "New",
				body: "",
				labels: [],
				assignees: [],
			}),
		).toBe(12);
		expect(api.issuesCreate).toHaveBeenCalledWith({
			...target,
			title: "New",
			body: "",
		});
		await runIssueAction("token", "acme/app", {
			action: "state",
			number: 4,
			state: "closed",
			reason: "not_planned",
		});
		expect(api.issuesUpdate).toHaveBeenCalledWith({
			...target,
			issue_number: 4,
			state: "closed",
			state_reason: "not_planned",
		});
	});

	it("asks for Issues: write when the App may only read issues", async () => {
		api.createComment.mockRejectedValue(
			Object.assign(new Error("Resource not accessible by integration"), {
				status: 403,
			}),
		);
		const refusal = (await runIssueAction("token", "acme/app", {
			action: "comment",
			number: 4,
			body: "Hi",
		}).catch((error: unknown) => error)) as Response;
		expect(((await refusal.json()) as { error: string }).error).toContain(
			'"Issues: write"',
		);
	});
});
