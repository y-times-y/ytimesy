import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { connectProject } from "../src/server/services/projects";

const adapter = vi.hoisted(() => ({
	authorize: vi.fn(),
	branch: vi.fn(),
	save: vi.fn(),
	token: vi.fn(),
	existing: vi.fn(),
	workspace: vi.fn(),
	failReady: vi.fn(),
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapter.authorize,
	githubClient: () => ({ repos: { getBranch: adapter.branch } }),
}));
vi.mock("../src/server/adapters/projects", () => ({
	saveProject: adapter.save,
	projectForRepository: adapter.existing,
}));
vi.mock("../src/server/adapters/workspaces", () => ({
	workspaceForProject: adapter.workspace,
	saveWorkspaceStatus: adapter.failReady,
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
