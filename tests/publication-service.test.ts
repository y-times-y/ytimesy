import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryWorkspaceRuntime } from "../src/server/adapters/workspace-runtime";
import { publishProject } from "../src/server/services/publication";

const adapter = vi.hoisted(() => ({
	token: vi.fn(),
	installationToken: vi.fn(),
	project: vi.fn(),
	authorize: vi.fn(),
	ahead: vi.fn(),
	create: vi.fn(),
	workspace: vi.fn(),
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: adapter.token,
}));
vi.mock("../src/server/adapters/github/installation-token", () => ({
	githubInstallationAccessToken: adapter.installationToken,
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: adapter.project,
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapter.authorize,
	compareBranchAhead: adapter.ahead,
	createDraftPullRequest: adapter.create,
}));
vi.mock("../src/server/adapters/workspaces", () => ({
	readyWorkspaceForOwner: adapter.workspace,
}));
vi.mock("../src/server/services/agent-session-machine", () => ({
	peekAgentSessionMachine: async () => ({
		session: { id: "sess" },
		providerRef: "memory:session",
	}),
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

async function readyRuntime() {
	const runtime = new MemoryWorkspaceRuntime();
	await runtime.provision("session");
	const templateRef = await runtime.provision("ws");
	adapter.workspace.mockResolvedValue({
		id: workspaceId,
		status: "ready",
		providerRef: templateRef,
	});
	return runtime;
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
	adapter.token.mockResolvedValue("user-token");
	adapter.installationToken.mockResolvedValue("ghs_install");
	adapter.project.mockResolvedValue({
		id: projectId,
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
	const runtime = new MemoryWorkspaceRuntime();
	const result = await Effect.runPromise(
		Effect.either(
			publishProject(
				"alice",
				{
					projectId,
					title: "Ship feature",
				},
				runtime,
			),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.create).not.toHaveBeenCalled();
	expect(runtime.commands).toHaveLength(0);
});

it("does not create a pull request before the workspace is ready", async () => {
	adapter.workspace.mockResolvedValue({
		id: workspaceId,
		status: "cloning",
		providerRef: "memory:ws",
	});
	const runtime = new MemoryWorkspaceRuntime();
	const result = await Effect.runPromise(
		Effect.either(
			publishProject("alice", { projectId, title: "Ship feature" }, runtime),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.create).not.toHaveBeenCalled();
	expect(runtime.commands).toHaveLength(0);
});

it("does not create a pull request when the branch is not ahead", async () => {
	const runtime = await readyRuntime();
	adapter.ahead.mockResolvedValue(0);
	const result = await Effect.runPromise(
		Effect.either(
			publishProject("alice", { projectId, title: "Ship feature" }, runtime),
		),
	);
	expect(result._tag).toBe("Left");
	expect(adapter.create).not.toHaveBeenCalled();
	expect(
		runtime.commands.some((command) =>
			command.argv.join(" ").includes("push -u"),
		),
	).toBe(true);
});

it("commits and pushes from the checkout before opening a draft pull request", async () => {
	vi.stubEnv("GITHUB_APP_BOT_USER_ID", "328807657");
	vi.stubEnv("GITHUB_APP_SLUG", "ytimesy-cloud");
	const runtime = await readyRuntime();
	adapter.ahead.mockResolvedValue(2);
	adapter.create.mockResolvedValue({
		number: 4,
		url: "https://github.example.test/acme/app/pull/4",
		draft: true,
	});
	const published = await Effect.runPromise(
		publishProject(
			"alice",
			{
				projectId,
				title: "Ship feature",
				body: "Ready for review.",
				authorName: "Alice",
				authorEmail: "alice@example.test",
			},
			runtime,
		),
	);
	expect(
		runtime.commands.some((command) =>
			command.argv.join(" ").includes("git add -A"),
		),
	).toBe(true);
	expect(
		runtime.commands.some((command) =>
			command.argv.join(" ").includes("user.name='Alice'"),
		),
	).toBe(true);
	expect(
		runtime.commands.some((command) =>
			command.argv
				.join(" ")
				.includes(
					"Co-authored-by: ytimesy-cloud[bot] <328807657+ytimesy-cloud[bot]@users.noreply.github.com>",
				),
		),
	).toBe(true);
	vi.unstubAllEnvs();
	expect(
		runtime.commands.some((command) =>
			command.argv.join(" ").includes("push -u"),
		),
	).toBe(true);
	expect(
		runtime.commands
			.find((command) => command.argv.join(" ").includes("push -u"))
			?.argv.join(" "),
	).not.toMatch(/user-token|ghs_install|ghp_/);
	expect(
		runtime.files.some((file) => file.path === "/tmp/ytimesy-gh-token"),
	).toBe(true);
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
		head: "feature",
		base: "master",
	});
});

it("publishes a workspace branch when the project is on the default branch", async () => {
	const runtime = await readyRuntime();
	adapter.project.mockResolvedValue({
		id: projectId,
		repositoryId: 2,
		installationId: 1,
		fullName: "acme/app",
		branch: "master",
	});
	adapter.ahead.mockResolvedValue(1);
	adapter.create.mockResolvedValue({
		number: 8,
		url: "https://github.example.test/acme/app/pull/8",
		draft: true,
	});
	await Effect.runPromise(
		publishProject("alice", { projectId, title: "Ship feature" }, runtime),
	);
	expect(adapter.create).toHaveBeenCalledWith("user-token", "acme/app", {
		title: "Ship feature",
		body: "",
		head: "ytimesy-222222222222",
		base: "master",
	});
});
