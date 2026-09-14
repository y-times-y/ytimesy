import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { publishProject } from "../src/server/services/publication";

const adapter = vi.hoisted(() => ({
	token: vi.fn(),
	project: vi.fn(),
	authorize: vi.fn(),
	ahead: vi.fn(),
	create: vi.fn(),
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: adapter.token,
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: adapter.project,
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapter.authorize,
	compareBranchAhead: adapter.ahead,
	createDraftPullRequest: adapter.create,
}));

beforeEach(() => {
	vi.resetAllMocks();
	adapter.token.mockResolvedValue("user-token");
	adapter.project.mockResolvedValue({
		id: "11111111-1111-4111-8111-111111111111",
		repositoryId: 2,
		installationId: 1,
		fullName: "acme/app",
		branch: "feature",
	});
	adapter.authorize.mockResolvedValue({
		installationId: 1,
		repositoryId: 2,
		fullName: "acme/app",
		defaultBranch: "master",
	});
});

it("does not create a pull request for another users project", async () => {
	adapter.project.mockResolvedValue(null);
	const result = await Effect.runPromise(
		Effect.either(
			publishProject("alice", {
				projectId: "11111111-1111-4111-8111-111111111111",
				title: "Ship feature",
			}),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.create).not.toHaveBeenCalled();
});

it("does not create a pull request when the branch is not ahead", async () => {
	adapter.ahead.mockResolvedValue(0);
	const result = await Effect.runPromise(
		Effect.either(
			publishProject("alice", {
				projectId: "11111111-1111-4111-8111-111111111111",
				title: "Ship feature",
			}),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.create).not.toHaveBeenCalled();
});

it("creates a draft pull request after GitHub write access and an ahead branch", async () => {
	adapter.ahead.mockResolvedValue(2);
	adapter.create.mockResolvedValue({
		number: 4,
		url: "https://github.example.test/acme/app/pull/4",
		draft: true,
	});
	const published = await Effect.runPromise(
		publishProject("alice", {
			projectId: "11111111-1111-4111-8111-111111111111",
			title: "Ship feature",
			body: "Ready for review.",
		}),
	);
	expect(adapter.create).toHaveBeenCalledWith("user-token", "acme/app", {
		title: "Ship feature",
		body: "Ready for review.",
		head: "feature",
		base: "master",
	});
	expect(published).toEqual({
		number: 4,
		url: "https://github.example.test/acme/app/pull/4",
		draft: true,
	});
});
