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

it("creates or reuses PRs as the installed app with repository-scoped PR permissions", async () => {
	api.token.mockResolvedValue("installation-token-fixture");
	api.pull.mockResolvedValue({
		url: "https://github.com/owner/repo/pull/1",
		draft: true,
	});
	const draft = {
		title: "Fix parser",
		body: "Evidence",
		head: "ytimesy/fix-parser-abcd",
		base: "main",
	};
	await ensureAppDraftPullRequest(123, "owner/repo", draft);
	expect(api.token).toHaveBeenCalledWith(123, {
		repositoryNames: ["repo"],
		contents: "read",
		pullRequests: "write",
	});
	expect(api.pull).toHaveBeenCalledWith(
		"installation-token-fixture",
		"owner/repo",
		draft,
	);
	api.pull.mockClear();
	api.token.mockRejectedValueOnce(
		new Error("App pull request permission missing"),
	);
	await expect(
		ensureAppDraftPullRequest(123, "owner/repo", draft),
	).rejects.toThrow("permission missing");
	expect(api.pull).not.toHaveBeenCalled();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});

it("links a project's pull request to Fix with ytimesy and records it for GitHub wake-ups", async () => {
	vi.stubEnv("APP_URL", "https://app.example/");
	api.token.mockResolvedValue("installation-token-fixture");
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
	await ensureAppDraftPullRequest(123, "owner/repo", draft, {
		userId: "alice",
		projectId: "project",
		repositoryId: 9,
		sessionId: "chat",
	});
	const sent = api.pull.mock.calls[0]?.[2];
	const linkId = api.record.mock.calls[0]?.[0].id;
	expect(sent.body).toContain(
		`[Fix with ytimesy](https://app.example/projects/project/pulls/${linkId}/fix)`,
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
		ensureAppDraftPullRequest(123, "owner/repo", draft, {
			userId: "alice",
			projectId: "project",
			repositoryId: 9,
			sessionId: null,
		}),
	).resolves.toMatchObject({ number: 7 });
	warn.mockRestore();
});
