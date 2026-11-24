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
	push: vi.fn(),
	peek: vi.fn(),
	commitIdentity: vi.fn(),
}));
vi.mock("../src/server/adapters/github/git-broker", () => ({
	pushBrokeredRepository: adapter.push,
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
}));
vi.mock("../src/server/adapters/github/commit-identity", () => ({
	githubCommitIdentityForToken: adapter.commitIdentity,
}));
vi.mock("../src/server/adapters/github/app-pull-request", () => ({
	ensureAppDraftPullRequest: adapter.create,
}));
vi.mock("../src/server/adapters/workspaces", () => ({
	readyWorkspaceForOwner: adapter.workspace,
}));
vi.mock("../src/server/services/agent-session-machine", () => ({
	peekAgentSessionMachine: adapter.peek,
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
	adapter.commitIdentity.mockResolvedValue(null);
	adapter.installationToken.mockResolvedValue("ghs_install");
	adapter.push.mockResolvedValue(undefined);
	adapter.peek.mockResolvedValue({
		session: { id: "sess" },
		providerRef: "memory:session",
	});
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

it("publishes the chat working branch against its selected starting branch", async () => {
	vi.stubEnv("GITHUB_APP_BOT_USER_ID", "328807657");
	vi.stubEnv("GITHUB_APP_SLUG", "ytimesy-cloud");
	const runtime = await readyRuntime();
	adapter.peek.mockResolvedValue({
		session: {
			id: "sess",
			workingBranch: "ytimesy/task-sess",
			baseBranch: "feature",
		},
		providerRef: "memory:session",
	});
	adapter.ahead.mockResolvedValue(1);
	adapter.create.mockResolvedValue({
		number: 9,
		url: "https://github.example.test/acme/app/pull/9",
		draft: true,
	});
	await Effect.runPromise(
		publishProject(
			"alice",
			{ projectId, sessionId: "sess", title: "Task" },
			runtime,
		),
	);
	expect(adapter.create).toHaveBeenCalledWith(
		1,
		"acme/app",
		expect.objectContaining({ head: "ytimesy/task-sess", base: "feature" }),
		// Recorded as this project's pull request so GitHub events can wake the chat.
		{ userId: "alice", projectId, repositoryId: 2, sessionId: "sess" },
		"user-token",
	);
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
	expect(adapter.push).toHaveBeenCalled();
});

it("commits as the managed bot, credits the verified human, and pushes before opening a draft pull request", async () => {
	adapter.commitIdentity.mockResolvedValue({
		name: "Verified Alice",
		email: "verified-alice@example.test",
	});
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
				authorName: "Unverified Name",
				authorEmail: "unverified@example.test",
			},
			runtime,
		),
	);
	const commit = runtime.commands.find(({ argv }) =>
		argv[2]?.includes("git add -A"),
	)?.argv[2];
	const botName = "ytimesy-agent[bot]";
	const botEmail = "328807657+ytimesy-agent[bot]@users.noreply.github.com";
	for (const role of ["AUTHOR", "COMMITTER"]) {
		expect(commit).toContain(`GIT_${role}_NAME='${botName}'`);
		expect(commit).toContain(`GIT_${role}_EMAIL='${botEmail}'`);
	}
	expect(commit).toContain(
		`--trailer 'Co-authored-by: ${botName} <${botEmail}>'`,
	);
	expect(adapter.commitIdentity).toHaveBeenCalledWith("user-token");
	expect(commit).toContain(
		"--trailer 'Co-authored-by: Verified Alice <verified-alice@example.test>'",
	);
	expect(commit).not.toContain("Unverified Name");
	expect(commit).not.toContain("unverified@example.test");
	expect(adapter.push).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			owner: "acme",
			name: "app",
			branch: "feature",
			installationId: 1,
		}),
	);
	expect(
		runtime.files.some((file) => file.path === "/tmp/ytimesy-gh-token"),
	).toBe(false);
	expect(adapter.create).toHaveBeenCalledWith(
		1,
		"acme/app",
		{
			title: "Ship feature",
			body: "Ready for review.",
			head: "feature",
			base: "master",
		},
		expect.objectContaining({ userId: "alice", projectId, repositoryId: 2 }),
		"user-token",
	);
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
	expect(adapter.create).toHaveBeenCalledWith(
		1,
		"acme/app",
		{
			title: "Ship feature",
			body: "",
			head: "ytimesy-222222222222",
			base: "master",
		},
		expect.objectContaining({ userId: "alice", projectId, sessionId: null }),
		"user-token",
	);
});
