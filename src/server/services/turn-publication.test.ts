import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { MemoryWorkspaceRuntime } from "../adapters/workspace-runtime";
import { publishCompletedSessionTurn } from "./turn-publication";

const deps = vi.hoisted(() => ({
	project: vi.fn(),
	token: vi.fn(),
	authorize: vi.fn(),
	push: vi.fn(),
	ahead: vi.fn(),
	pull: vi.fn(),
	save: vi.fn(),
	predecessor: vi.fn(),
}));
vi.mock("../adapters/projects", () => ({ projectForOwner: deps.project }));
vi.mock("../auth/github-connection", () => ({ githubAccessToken: deps.token }));
vi.mock("../adapters/github", () => ({
	authorizedRepository: deps.authorize,
	compareBranchAhead: deps.ahead,
}));
vi.mock("../adapters/github/app-pull-request", () => ({
	ensureAppDraftPullRequest: deps.pull,
}));
vi.mock("../adapters/github/git-broker", () => ({
	pushBrokeredRepository: deps.push,
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: deps.predecessor,
	saveAgentTaskPublication: deps.save,
}));
const turn = "a".repeat(64);
const session = {
	id: "chat-abcd",
	userId: "alice",
	projectId: "project",
	providerRef: "writer",
	parentSessionId: "lead",
	taskAccess: "read_write",
	taskPlacement: "fresh",
	title: "Fix parser",
	baseBranch: "main",
} as AgentSessionRecord;
beforeEach(() => {
	vi.resetAllMocks();
	deps.project.mockResolvedValue({
		fullName: "owner/primary",
		repositoryId: 1,
		installationId: 2,
		branch: "main",
		repositories: [
			{
				fullName: "owner/primary",
				repositoryId: 1,
				installationId: 2,
				branch: "main",
			},
			{
				fullName: "owner/secondary",
				repositoryId: 3,
				installationId: 2,
				branch: "develop",
			},
		],
	});
	deps.token.mockResolvedValue("owner-token");
	deps.authorize.mockResolvedValue({ defaultBranch: "main" });
	deps.ahead.mockResolvedValue(1);
	deps.pull.mockResolvedValue({
		url: "https://github.com/owner/primary/pull/1",
		draft: true,
	});
});
it("pushes the completed revision for each repository and records the primary draft handoff", async () => {
	const runtime = new MemoryWorkspaceRuntime({
		exitCode: 0,
		stdout: "1\n",
		stderr: "",
	});
	await publishCompletedSessionTurn(session, runtime, turn);
	expect(deps.project).toHaveBeenCalledWith("alice", "project");
	expect(deps.token).toHaveBeenCalledTimes(1);
	expect(deps.push.mock.calls.map((call) => call[1].baseBranch)).toEqual([
		"main",
		"develop",
	]);
	for (const [, input] of deps.push.mock.calls) {
		expect(input.branch).toBe("ytimesy/fix-parser-abcd");
		expect(input.revision).toBe(`refs/ytimesy/turn-commits/${turn}`);
	}
	expect(deps.pull).toHaveBeenCalledTimes(2);
	expect(deps.save).toHaveBeenCalledWith("chat-abcd", {
		branch: "ytimesy/fix-parser-abcd",
		pullRequestUrl: "https://github.com/owner/primary/pull/1",
	});
});
it("does not push or request credentials for a chat without commits since its base", async () => {
	await publishCompletedSessionTurn(
		session,
		new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "0\n", stderr: "" }),
		turn,
	);
	expect(deps.token).not.toHaveBeenCalled();
	expect(deps.push).not.toHaveBeenCalled();
	expect(deps.pull).not.toHaveBeenCalled();
});
it("keeps the published branch and uses the stacked predecessor as the primary base", async () => {
	deps.predecessor.mockResolvedValue({
		taskBranch: "ytimesy/predecessor-ab12",
		projectId: "project",
	});
	await publishCompletedSessionTurn(
		{
			...session,
			taskBranch: "ytimesy/existing-abcd",
			taskExecution: "stacked",
			dependsOnSessionId: "previous",
		},
		new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1", stderr: "" }),
		turn,
	);
	expect(deps.push.mock.calls[0][1]).toMatchObject({
		branch: "ytimesy/existing-abcd",
		baseBranch: "ytimesy/predecessor-ab12",
	});
});
it("fails a rejected push without creating a PR or recording publication", async () => {
	deps.push.mockRejectedValue(new Error("Non-fast-forward push rejected"));
	await expect(
		publishCompletedSessionTurn(
			session,
			new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1", stderr: "" }),
			turn,
		),
	).rejects.toThrow("Non-fast-forward");
	expect(deps.pull).not.toHaveBeenCalled();
	expect(deps.save).not.toHaveBeenCalled();
});
it("never automatically pushes to the repository default branch", async () => {
	await expect(
		publishCompletedSessionTurn(
			{ ...session, workingBranch: "main" },
			new MemoryWorkspaceRuntime({ exitCode: 0, stdout: "1", stderr: "" }),
			turn,
		),
	).rejects.toThrow("separate task branch");
	expect(deps.push).not.toHaveBeenCalled();
});
