import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveEnvironmentBuildInput } from "../src/server/services/environment-build";

const fixture = vi.hoisted(() => ({
	previousHash: "",
	sha: "a".repeat(40),
	secretVersion: 1,
	snapshot: true,
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async () => ({ rows: [{ input_hash: fixture.previousHash }] }),
	}),
}));
vi.mock("../src/server/adapters/workspaces", () => ({
	workspaceById: async () => ({
		id: "workspace",
		userId: "alice",
		projectId: "project",
		templateSnapshotId: "snapshot",
	}),
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: async () => ({
		id: "project",
		name: "App",
		repositories: [
			{
				fullName: "org/web",
				branch: "main",
				installationId: 1,
				repositoryId: 1,
			},
			{
				fullName: "org/api",
				branch: "main",
				installationId: 1,
				repositoryId: 2,
			},
		],
	}),
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: async () => "fixture-token",
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: async (
		_token: string,
		_installation: number,
		id: number,
	) => ({ fullName: id === 1 ? "org/web" : "org/api", defaultBranch: "main" }),
	repositoryBranchSha: async (_token: string, name: string) =>
		name === "org/api" ? fixture.sha : "a".repeat(40),
}));
vi.mock("../src/server/adapters/project-secrets", () => ({
	loadProjectSecretsForOwner: async () => [
		{
			id: "secret",
			name: "PACKAGE_TOKEN",
			encrypted: { ciphertext: `encrypted-${fixture.secretVersion}` },
		},
	],
}));
vi.mock("../src/server/records/tools-snapshot-store", () => ({
	readToolsSnapshotId: async () => "stored-tools",
}));
vi.mock("../src/server/adapters/freestyle/workspace-runtime", () => ({
	workspaceRuntimeFromEnv: () => ({
		snapshotExists: async () => fixture.snapshot,
	}),
}));

beforeEach(() => {
	fixture.previousHash = "";
	fixture.sha = "a".repeat(40);
	fixture.secretVersion = 1;
	fixture.snapshot = true;
	vi.stubEnv("YTIMESY_TOOLS_SNAPSHOT_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

it("uses only the tools image and keeps credentials out of persisted inputs", async () => {
	const input = await resolveEnvironmentBuildInput("workspace", false);
	expect(input?.baseSnapshotId).toBe("stored-tools");
	expect(input?.repositories).toHaveLength(2);
	expect(JSON.stringify(input)).not.toMatch(/fixture-token|encrypted-1/);
	vi.stubEnv("YTIMESY_TOOLS_SNAPSHOT_ID", "pinned-tools");
	expect(
		(await resolveEnvironmentBuildInput("workspace", false))?.baseSnapshotId,
	).toBe("pinned-tools");
});

it("skips unchanged preparation only while the private snapshot still exists", async () => {
	const input = await resolveEnvironmentBuildInput("workspace", false);
	expect(input).not.toBeNull();
	fixture.previousHash = input?.inputHash ?? "";
	expect(await resolveEnvironmentBuildInput("workspace", false)).toBeNull();
	expect(await resolveEnvironmentBuildInput("workspace", true)).not.toBeNull();
	fixture.snapshot = false;
	expect(await resolveEnvironmentBuildInput("workspace", false)).not.toBeNull();
});

it("invalidates a cached build when a secondary repository or secret changes", async () => {
	const input = await resolveEnvironmentBuildInput("workspace", false);
	expect(input).not.toBeNull();
	fixture.previousHash = input?.inputHash ?? "";
	fixture.sha = "b".repeat(40);
	expect(await resolveEnvironmentBuildInput("workspace", false)).not.toBeNull();
	fixture.sha = "a".repeat(40);
	fixture.secretVersion = 2;
	expect(await resolveEnvironmentBuildInput("workspace", false)).not.toBeNull();
});
