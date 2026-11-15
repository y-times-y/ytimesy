import { beforeEach, expect, it, vi } from "vitest";
import { Route as IssueRoute } from "../src/routes/api/github/issue";
import { Route as PullRoute } from "../src/routes/api/github/pull-request";

const api = vi.hoisted(() => ({
	repository: vi.fn(),
	issue: vi.fn(),
	issues: vi.fn(),
	issueAction: vi.fn(),
	pull: vi.fn(),
	pulls: vi.fn(),
	pullAction: vi.fn(),
	ready: vi.fn(),
	merge: vi.fn(),
	choices: vi.fn(),
	log: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({ APP_URL: "https://app.example" }),
}));
vi.mock("../src/server/adapters/analytics", () => ({
	captureServerException: vi.fn(),
}));
vi.mock(
	"../src/server/services/github-repository-request",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/server/services/github-repository-request")
		>()),
		githubRepositoryFor: api.repository,
	}),
);
vi.mock("../src/server/adapters/github/issues", () => ({
	issueDetail: api.issue,
	listIssues: api.issues,
	runIssueAction: api.issueAction,
}));
vi.mock("../src/server/adapters/github", () => ({
	pullRequestDetail: api.pull,
	listOpenPullRequests: api.pulls,
	markPullRequestReady: api.ready,
	mergePullRequest: api.merge,
}));
vi.mock("../src/server/adapters/github/pull-request-list", () => ({
	listRepositoryPullRequests: api.pulls,
}));
vi.mock("../src/server/adapters/github/pull-request-actions", () => ({
	repositoryChoices: api.choices,
	actionsJobLog: api.log,
	runPullRequestAction: api.pullAction,
}));

type Handlers = {
	server: {
		handlers: {
			POST: (context: { request: Request }) => Promise<Response>;
			GET: (context: { request: Request }) => Promise<Response>;
		};
	};
};
const issue = (IssueRoute.options as unknown as Handlers).server.handlers;
const pull = (PullRoute.options as unknown as Handlers).server.handlers;
const target = { installationId: 11, repositoryId: 22, number: 74 };
const post = (body: unknown, origin = "https://app.example") =>
	new Request("https://app.example/api/github/pull-request", {
		method: "POST",
		headers: { origin, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	vi.resetAllMocks();
	api.repository.mockResolvedValue({
		token: "user-token",
		fullName: "sample/editor",
		refused: (error: unknown) => {
			throw error;
		},
	});
	api.pull.mockResolvedValue({ number: 74 });
	api.issue.mockResolvedValue({ number: 39 });
	api.issueAction.mockResolvedValue(39);
});
it("rejects cross-origin mutations before token access or a write", async () => {
	for (const handlers of [issue, pull])
		expect(
			(
				await handlers.POST({
					request: post(
						{ ...target, action: "comment", body: "Hi" },
						"https://evil.example",
					),
				})
			).status,
		).toBe(403);
	expect(api.repository).not.toHaveBeenCalled();
	expect(api.pullAction).not.toHaveBeenCalled();
	expect(api.issueAction).not.toHaveBeenCalled();
});
it("checks fresh repository authority and only forwards a validated PR action", async () => {
	const request = post({
		...target,
		action: "comment",
		body: "Ready",
		untrusted: "ignored",
	});
	expect((await pull.POST({ request })).status).toBe(200);
	expect(api.repository).toHaveBeenCalledWith(request, target, {
		reuseAccess: false,
	});
	expect(api.pullAction).toHaveBeenCalledWith(
		"user-token",
		"sample/editor",
		74,
		{ action: "comment", body: "Ready" },
	);
});
it("keeps the existing ready and head-fenced merge contracts", async () => {
	expect(
		(await pull.POST({ request: post({ ...target, action: "ready" }) })).status,
	).toBe(200);
	expect(api.ready).toHaveBeenCalledWith("user-token", "sample/editor", 74);
	const headSha = "b".repeat(40);
	expect(
		(
			await pull.POST({
				request: post({ ...target, action: "merge", headSha }),
			})
		).status,
	).toBe(200);
	expect(api.merge).toHaveBeenCalledWith(
		"user-token",
		"sample/editor",
		74,
		headSha,
	);
});
it("creates an issue using only the selected repository and validated fields", async () => {
	const request = post({
		...target,
		action: "create",
		title: " Restore focus ",
		body: "Steps",
		labels: ["bug"],
		assignees: ["riley"],
	});
	expect((await issue.POST({ request })).status).toBe(200);
	expect(api.issueAction).toHaveBeenCalledWith("user-token", "sample/editor", {
		action: "create",
		title: "Restore focus",
		body: "Steps",
		labels: ["bug"],
		assignees: ["riley"],
	});
	expect(api.issue).toHaveBeenCalledWith("user-token", "sample/editor", 39);
});
it("rejects invalid input and denied identities without a write", async () => {
	expect(
		(
			await pull.POST({
				request: post({ ...target, action: "comment", body: " " }),
			})
		).status,
	).toBe(400);
	expect(api.pullAction).not.toHaveBeenCalled();
	api.repository.mockRejectedValue(new Response("Sign in", { status: 401 }));
	expect(
		(
			await issue.POST({
				request: post({ ...target, action: "comment", body: "Hi" }),
			})
		).status,
	).toBe(401);
	expect(api.issueAction).not.toHaveBeenCalled();
});
