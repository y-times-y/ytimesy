import { expect, it, vi } from "vitest";
import { GITHUB_SETUP_MESSAGE } from "#/domain/github-sign-in";

const { saveWorkspaceStatus } = vi.hoisted(() => ({
	saveWorkspaceStatus: vi.fn(async () => undefined),
}));
vi.mock("../adapters/workspaces", () => ({
	insertQueuedWorkspace: vi.fn(async () => ({ id: "w1" })),
	saveWorkspaceStatus,
}));
vi.mock("../adapters/model-connections", () => ({
	listModelConnections: async () => [{ id: "m" }],
}));
vi.mock("../adapters/projects", () => ({
	saveProject: async () => ({ id: "p1" }),
}));
vi.mock("./y-on-add", () => ({ createProjectYSquared: async () => "y1" }));
vi.mock("./workspaces", () => ({ enqueueProjectWorkspace: vi.fn() }));
vi.mock("../adapters/github", () => ({
	githubClient: () => ({
		apps: { listReposAccessibleToInstallation: "x" },
		paginate: async () => [
			{
				id: 7,
				full_name: "y-times-y/ytimesy",
				default_branch: "main",
				private: false,
			},
		],
	}),
}));
vi.mock("../adapters/github/installation-token", () => ({
	githubInstallationAccessToken: async () => "ghs_x",
}));

import { seedTestAccount } from "./test-account-seed";

it("leaves the project in the linked-out state: setup failed with the connect prompt, no build queued", async () => {
	const result = await seedTestAccount(
		{
			query: async () =>
				({ rows: [{ repository_id: "1", installation_id: "2" }] }) as never,
		},
		"ytimesy-test-account",
		{ githubUnlinked: true },
	);
	expect(result.projectId).toBe("p1");
	expect(saveWorkspaceStatus).toHaveBeenCalledWith(
		"w1",
		"failed",
		GITHUB_SETUP_MESSAGE,
	);
});
