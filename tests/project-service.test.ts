import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { connectProject } from "../src/server/services/projects";

const adapter = vi.hoisted(() => ({
	authorize: vi.fn(),
	branch: vi.fn(),
	save: vi.fn(),
	token: vi.fn(),
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapter.authorize,
	githubClient: () => ({ repos: { getBranch: adapter.branch } }),
}));
vi.mock("../src/server/adapters/projects", () => ({
	saveProject: adapter.save,
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: adapter.token,
}));
beforeEach(() => {
	vi.resetAllMocks();
	adapter.token.mockResolvedValue("user-token");
});
it("does not save a repository outside the users GitHub access", async () => {
	adapter.authorize.mockRejectedValue(
		new Response("Forbidden", { status: 403 }),
	);
	const result = await Effect.runPromise(
		Effect.either(
			connectProject("alice", {
				installationId: 1,
				repositoryId: 2,
				branch: "main",
			}),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.save).not.toHaveBeenCalled();
	expect(adapter.branch).not.toHaveBeenCalled();
});
it("does not save a nonexistent branch", async () => {
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
	});
	adapter.branch.mockRejectedValue(new Error("Not found"));
	const result = await Effect.runPromise(
		Effect.either(
			connectProject("alice", {
				installationId: 1,
				repositoryId: 2,
				branch: "missing",
			}),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.save).not.toHaveBeenCalled();
});
