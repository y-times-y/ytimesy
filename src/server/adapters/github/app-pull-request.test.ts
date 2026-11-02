import { afterEach, expect, it, vi } from "vitest";
import { ensureAppDraftPullRequest } from "./app-pull-request";

const api = vi.hoisted(() => ({
	token: vi.fn(),
	pull: vi.fn(),
	record: vi.fn(),
}));
vi.mock("../pull-request-links", () => ({ recordPullRequestLink: api.record }));
vi.mock("./installation-token", () => ({
	githubInstallationAccessToken: api.token,
}));
vi.mock("../github", () => ({ ensureDraftPullRequest: api.pull }));

it("opens the pull request as the signed-in user, and as the app only without one", async () => {
	api.pull.mockResolvedValue({
		url: "https://github.com/owner/repo/pull/1",
		draft: true,
	});
	const draft = {
		title: "Fix parser",
		body: "The parser rejects an empty token.",
		head: "ytimesy/fix-parser-abcd",
		base: "main",
	};
	await ensureAppDraftPullRequest(
		123,
		"owner/repo",
		draft,
		undefined,
		"user-token",
	);
	expect(api.token).not.toHaveBeenCalled();
	const signed = {
		...draft,
		body: expect.stringMatching(
			/^The parser rejects an empty token\.\n\n<!-- ytimesy-fix:start -->[\s\S]*Generated with ytimesy\n<!-- ytimesy-fix:end -->$/,
		),
	};
	expect(api.pull).toHaveBeenCalledWith("user-token", "owner/repo", signed);
	api.pull.mockClear();
	api.token.mockResolvedValue("app-token");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	await ensureAppDraftPullRequest(123, "owner/repo", draft);
	expect(api.token).toHaveBeenCalledWith(123, {
		repositoryNames: ["repo"],
		contents: "read",
		pullRequests: "write",
	});
	expect(api.pull).toHaveBeenCalledWith("app-token", "owner/repo", signed);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});

it("links a project's pull request to Fix with ytimesy and records it for GitHub wake-ups", async () => {
	vi.stubEnv("APP_URL", "https://app.example/");
	vi.stubEnv("GITHUB_APP_SLUG", "ytimesy-agent");
	api.pull.mockResolvedValue({
		number: 7,
		url: "https://github.com/owner/repo/pull/7",
		draft: true,
	});
	api.record.mockResolvedValue("link");
	const draft = {
		title: "Fix",
		body: "Handoff.",
		head: "ytimesy/x-ab12",
		base: "main",
	};
	await ensureAppDraftPullRequest(
		123,
		"owner/repo",
		draft,
		{
			userId: "alice",
			projectId: "project",
			repositoryId: 9,
			sessionId: "chat",
		},
		"user-token",
	);
	const sent = api.pull.mock.calls[0]?.[2];
	const linkId = api.record.mock.calls[0]?.[0].id;
	expect(sent.body).toContain(
		`[Fix with ytimesy](https://app.example/projects/project/pulls/${linkId}/fix) · or comment \`@ytimesy-agent <what to change>\``,
	);
	expect(sent.body).toMatch(
		/Generated with \[ytimesy\]\(https:\/\/app\.example\/\?project=project&chat=chat\)\n<!-- ytimesy-fix:end -->$/,
	);
	expect(api.record).toHaveBeenCalledWith({
		id: linkId,
		userId: "alice",
		projectId: "project",
		installationId: 123,
		repositoryId: 9,
		fullName: "owner/repo",
		pullNumber: 7,
		headRef: "ytimesy/x-ab12",
		baseRef: "main",
		originSessionId: "chat",
	});
	// A failed record never fails the handoff.
	api.record.mockRejectedValueOnce(new Error("db down"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await expect(
		ensureAppDraftPullRequest(
			123,
			"owner/repo",
			draft,
			{
				userId: "alice",
				projectId: "project",
				repositoryId: 9,
				sessionId: null,
			},
			"user-token",
		),
	).resolves.toMatchObject({ number: 7 });
	warn.mockRestore();
});
