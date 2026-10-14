import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import {
	connectProject,
	connectProjectGroup,
} from "../src/server/services/projects";

const adapter = vi.hoisted(() => ({
	authorize: vi.fn(),
	branch: vi.fn(),
	save: vi.fn(),
	token: vi.fn(),
	existing: vi.fn(),
	workspace: vi.fn(),
	failReady: vi.fn(),
	list: vi.fn(),
	saveGroup: vi.fn(),
	enqueue: vi.fn(),
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapter.authorize,
	repositoryBranchSha: adapter.branch,
}));
vi.mock("../src/server/adapters/projects", () => ({
	saveProject: adapter.save,
	saveProjectGroup: adapter.saveGroup,
	listProjects: adapter.list,
	projectForRepository: adapter.existing,
}));
vi.mock("../src/server/adapters/workspaces", () => ({
	workspaceForProject: adapter.workspace,
	saveWorkspaceStatus: adapter.failReady,
}));
vi.mock("../src/server/services/workspaces", () => ({
	enqueueProjectWorkspace: adapter.enqueue,
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: adapter.token,
}));
beforeEach(() => {
	vi.resetAllMocks();
	adapter.token.mockResolvedValue("user-token");
	adapter.existing.mockResolvedValue(null);
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
it("normalizes the legacy generated project branch to the repository default", async () => {
	adapter.branch.mockResolvedValue({});
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
		defaultBranch: "main",
	});
	adapter.save.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "ytimesy",
	});
	const enqueue = vi.fn(() =>
		Effect.succeed({
			id: "ws",
			userId: "alice",
			projectId: "proj",
			status: "queued" as const,
			providerRef: null,
			templateSnapshotId: null,
			errorMessage: null,
			updatedAt: new Date(0).toISOString(),
		}),
	);
	await Effect.runPromise(
		connectProject(
			"alice",
			{ installationId: 1, repositoryId: 2, branch: "ytimesy" },
			enqueue,
		),
	);
	expect(adapter.branch).toHaveBeenCalledWith(
		"user-token",
		"test/repo",
		"main",
	);
	expect(adapter.save).toHaveBeenCalledWith("alice", expect.anything(), "main");
});

it("does not save a nonexistent branch", async () => {
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
	});
	adapter.branch.mockResolvedValue(null);
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
	const failure = result._tag === "Left" ? result.left.error : null;
	expect(failure).toBeInstanceOf(Response);
	expect(await (failure as Response).text()).toBe(
		"Branch missing does not exist in test/repo.",
	);
	expect(adapter.save).not.toHaveBeenCalled();
});
it("queues workspace preparation only after the project is saved", async () => {
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
	});
	adapter.branch.mockResolvedValue({});
	adapter.save.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "main",
	});
	const enqueue = vi.fn(() =>
		Effect.succeed({
			id: "ws",
			userId: "alice",
			projectId: "proj",
			status: "queued" as const,
			providerRef: null,
			templateSnapshotId: null,
			errorMessage: null,
			updatedAt: new Date(0).toISOString(),
		}),
	);
	await Effect.runPromise(
		connectProject(
			"alice",
			{ installationId: 1, repositoryId: 2, branch: "main" },
			enqueue,
		),
	);
	expect(adapter.save).toHaveBeenCalledOnce();
	expect(enqueue).toHaveBeenCalledWith("alice", "proj");
});

it("does not change branch while the workspace is still preparing", async () => {
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
	});
	adapter.branch.mockResolvedValue({});
	adapter.existing.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "main",
	});
	adapter.workspace.mockResolvedValue({
		id: "ws",
		userId: "alice",
		projectId: "proj",
		status: "cloning",
		providerRef: "vm-1",
		templateSnapshotId: null,
		errorMessage: null,
		updatedAt: new Date(0).toISOString(),
	});
	const result = await Effect.runPromise(
		Effect.either(
			connectProject("alice", {
				installationId: 1,
				repositoryId: 2,
				branch: "develop",
			}),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.save).not.toHaveBeenCalled();
	expect(adapter.failReady).not.toHaveBeenCalled();
});

it("marks a ready workspace failed so Retry can clone the new branch", async () => {
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
		defaultBranch: "main",
	});
	adapter.branch.mockResolvedValue({});
	adapter.existing.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "main",
	});
	adapter.workspace.mockResolvedValue({
		id: "ws",
		userId: "alice",
		projectId: "proj",
		status: "ready",
		providerRef: "vm-1",
		templateSnapshotId: null,
		errorMessage: null,
		updatedAt: new Date(0).toISOString(),
	});
	adapter.failReady.mockResolvedValue({});
	adapter.save.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "develop",
	});
	const enqueue = vi.fn(() =>
		Effect.succeed({
			id: "ws",
			userId: "alice",
			projectId: "proj",
			status: "queued" as const,
			providerRef: "vm-1",
			templateSnapshotId: null,
			errorMessage: null,
			updatedAt: new Date(0).toISOString(),
		}),
	);
	await Effect.runPromise(
		connectProject(
			"alice",
			{ installationId: 1, repositoryId: 2, branch: "develop" },
			enqueue,
		),
	);
	expect(adapter.failReady).toHaveBeenCalledWith(
		"ws",
		"failed",
		"Branch changed. Retry to prepare this branch.",
	);
	expect(adapter.save).toHaveBeenCalledOnce();
});

it("does not restart a ready workspace when the branch is unchanged", async () => {
	adapter.authorize.mockResolvedValue({
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
	});
	adapter.branch.mockResolvedValue({});
	adapter.existing.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "main",
	});
	adapter.workspace.mockResolvedValue({
		id: "ws",
		userId: "alice",
		projectId: "proj",
		status: "ready",
		providerRef: "vm-1",
		templateSnapshotId: null,
		errorMessage: null,
		updatedAt: new Date(0).toISOString(),
	});
	adapter.save.mockResolvedValue({
		id: "proj",
		repositoryId: 2,
		installationId: 1,
		fullName: "test/repo",
		branch: "main",
	});
	const enqueue = vi.fn(() =>
		Effect.succeed({
			id: "ws",
			userId: "alice",
			projectId: "proj",
			status: "ready" as const,
			providerRef: "vm-1",
			templateSnapshotId: null,
			errorMessage: null,
			updatedAt: new Date(0).toISOString(),
		}),
	);
	await Effect.runPromise(
		connectProject(
			"alice",
			{ installationId: 1, repositoryId: 2, branch: "main" },
			enqueue,
		),
	);
	expect(adapter.failReady).not.toHaveBeenCalled();
	expect(adapter.save).toHaveBeenCalledOnce();
});

it("reports clashing folder names as a request the user can fix", async () => {
	adapter.branch.mockResolvedValue("sha");
	adapter.authorize.mockImplementation(
		async (_token, installationId, repositoryId) => ({
			fullName: repositoryId === 2 ? "one/app" : "two/app",
			installationId,
			repositoryId,
			defaultBranch: "main",
		}),
	);
	const result = await Effect.runPromise(
		Effect.either(
			connectProjectGroup("alice", {
				name: "Both",
				repositories: [
					{ installationId: 1, repositoryId: 2, branch: "main" },
					{ installationId: 1, repositoryId: 3, branch: "main" },
				],
			}),
		),
	);
	expect(result._tag).toBe("Left");
	const failure = result._tag === "Left" ? result.left.error : null;
	expect((failure as Response).status).toBe(400);
	expect(await (failure as Response).text()).toMatch(/different folder names/);
});

it("reuses the project that already holds a repository instead of duplicating it", async () => {
	adapter.branch.mockResolvedValue("sha");
	adapter.enqueue.mockReturnValue(Effect.succeed({}));
	const repository = {
		fullName: "test/repo",
		installationId: 1,
		repositoryId: 2,
		defaultBranch: "main",
	};
	adapter.authorize.mockResolvedValue(repository);
	const existing = { ...repository, id: "proj", name: "repo", branch: "main" };
	adapter.list.mockResolvedValue([
		{
			...existing,
			id: "group",
			name: "Group",
			repositories: [
				{ ...repository, branch: "main" },
				{
					...repository,
					repositoryId: 3,
					fullName: "test/api",
					branch: "main",
				},
			],
		},
		existing,
	]);
	const project = await Effect.runPromise(
		connectProjectGroup("alice", {
			name: "repo",
			repositories: [{ installationId: 1, repositoryId: 2, branch: "main" }],
		}),
	);
	expect(project.id).toBe("proj");
	expect(adapter.saveGroup).not.toHaveBeenCalled();
	expect(adapter.enqueue).toHaveBeenCalledWith("alice", "proj");
});
