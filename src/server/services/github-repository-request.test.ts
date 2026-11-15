import { beforeEach, expect, it, vi } from "vitest";
import { githubRepositoryFor } from "./github-repository-request";

const api = vi.hoisted(() => ({
	user: vi.fn(),
	token: vi.fn(),
	authorize: vi.fn(),
	cached: vi.fn(),
	refused: vi.fn(),
}));
vi.mock("../auth/auth", () => ({ requireUser: api.user }));
vi.mock("../auth/github-connection", () => ({ githubAccessToken: api.token }));
vi.mock("../adapters/github", () => ({ authorizedRepository: api.authorize }));
vi.mock("../adapters/github/repository-access-cache", () => ({
	repositoryAccess: { access: api.cached, refused: api.refused },
}));
const target = { installationId: 11, repositoryId: 22 };
const request = new Request("https://app.example/api/github/issue");
beforeEach(() => {
	vi.resetAllMocks();
	api.user.mockResolvedValue({ id: "alice" });
	api.token.mockResolvedValue("private-user-token");
	api.authorize.mockResolvedValue({ fullName: "acme/app" });
	api.cached.mockImplementation((_key, check) => check());
});
it("always rechecks mutations with GitHub instead of trusting a cached grant", async () => {
	await expect(
		githubRepositoryFor(request, target, { reuseAccess: false }),
	).resolves.toMatchObject({ fullName: "acme/app" });
	expect(api.authorize).toHaveBeenCalledWith("private-user-token", 11, 22);
	expect(api.cached).not.toHaveBeenCalled();
	expect(api.refused).toHaveBeenCalledWith({ userId: "alice", ...target });
});
it("keys cached read authorization to the owner and installation", async () => {
	await githubRepositoryFor(request, target, { reuseAccess: true });
	expect(api.cached).toHaveBeenCalledWith(
		{ userId: "alice", ...target },
		expect.any(Function),
	);
});
it("does not reach credentials or GitHub for a signed-out request", async () => {
	api.user.mockRejectedValue(new Response("Sign in", { status: 401 }));
	await expect(
		githubRepositoryFor(request, target, { reuseAccess: false }),
	).rejects.toMatchObject({ status: 401 });
	expect(api.token).not.toHaveBeenCalled();
	expect(api.authorize).not.toHaveBeenCalled();
});
it("propagates revoked repository access without returning a repository", async () => {
	api.authorize.mockRejectedValue(new Response("Not allowed", { status: 403 }));
	await expect(
		githubRepositoryFor(request, target, { reuseAccess: false }),
	).rejects.toMatchObject({ status: 403 });
});
