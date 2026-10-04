import { expect, it, vi } from "vitest";
import { ensureAppDraftPullRequest } from "./app-pull-request";

const api = vi.hoisted(() => ({ token: vi.fn(), pull: vi.fn() }));
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
