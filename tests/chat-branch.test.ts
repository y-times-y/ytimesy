import { beforeEach, expect, it, vi } from "vitest";
import { commitChatBranchForSubmission } from "../src/server/services/session-branch";

const adapters = vi.hoisted(() => ({
	session: vi.fn(),
	project: vi.fn(),
	selection: vi.fn(),
	working: vi.fn(),
	branch: vi.fn(),
	repository: vi.fn(),
	held: vi.fn(),
	remote: vi.fn(),
	token: vi.fn(),
	githubConnected: vi.fn(),
}));
vi.mock("../src/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: adapters.session,
	saveSessionBranchSelection: adapters.selection,
	saveSessionWorkingBranch: adapters.working,
	projectBranchHeldByOtherSession: adapters.held,
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: adapters.project,
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapters.repository,
	repositoryBranchSha: adapters.remote,
	githubClient: () => ({ repos: { getBranch: adapters.branch } }),
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: adapters.token,
	githubConnectionExists: adapters.githubConnected,
}));
const input = {
	userId: "alice",
	projectId: "project",
	sessionId: "chat-abcd",
	text: "Fix parser",
};
beforeEach(() => {
	vi.resetAllMocks();
	adapters.session.mockResolvedValue({
		id: input.sessionId,
		projectId: input.projectId,
		turnStatus: "idle",
		items: [],
		parentSessionId: null,
	});
	adapters.project.mockResolvedValue({
		id: input.projectId,
		fullName: "owner/repo",
		branch: "main",
		installationId: 1,
		repositoryId: 2,
	});
	adapters.repository.mockResolvedValue({
		defaultBranch: "main",
		fullName: "owner/repo",
	});
	adapters.held.mockResolvedValue(false);
	adapters.remote.mockResolvedValue(null);
	adapters.token.mockResolvedValue("test-only");
	adapters.githubConnected.mockResolvedValue(true);
});
it("a new chat without GitHub says how to send, not how to pick repositories", async () => {
	adapters.token.mockRejectedValue(
		new Response("Connect GitHub to choose repositories.", { status: 409 }),
	);
	adapters.githubConnected.mockResolvedValue(false);
	await expect(commitChatBranchForSubmission(input)).rejects.toThrow(
		"Connect GitHub to send.",
	);
	expect(adapters.working).not.toHaveBeenCalled();
});
it("generates a task-specific branch only on first submission", async () => {
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-caabcd",
		"main",
	);
});
it("also forks a new task from a selected feature branch without renaming the source", async () => {
	adapters.session.mockResolvedValue({
		id: input.sessionId,
		projectId: input.projectId,
		turnStatus: "idle",
		items: [],
		selectedBranch: "feature/source",
	});
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-caabcd",
		"feature/source",
	);
});
it("a connected but empty chat still generates on submission, not Connect", async () => {
	adapters.session.mockResolvedValue({
		id: input.sessionId,
		projectId: input.projectId,
		turnStatus: "idle",
		items: [],
		providerRef: "vm",
		selectedBranch: "main",
	});
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-caabcd",
		"main",
	);
});
it("switching an existing chat to main does not rename main", async () => {
	adapters.session.mockResolvedValue({
		id: input.sessionId,
		projectId: input.projectId,
		turnStatus: "completed",
		workingBranch: "ytimesy/fix-parser-caabcd",
		selectedBranch: "main",
	});
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"main",
		"main",
	);
});
it("leaves legacy conversations and their existing checkout unchanged", async () => {
	adapters.session.mockResolvedValue({
		id: input.sessionId,
		projectId: input.projectId,
		turnStatus: "completed",
		items: [{ kind: "userMessage", id: "message", text: "hi" }],
	});
	await commitChatBranchForSubmission(input);
	expect(adapters.working).not.toHaveBeenCalled();
});

it("adds a short suffix when another chat holds the name or it already exists on GitHub", async () => {
	adapters.held.mockImplementation(
		async (_user, _project, _session, branch: string) =>
			branch === "ytimesy/fix-parser-caabcd",
	);
	adapters.remote.mockImplementation(async (_token, _repo, branch: string) =>
		branch === "ytimesy/fix-parser-caabcd-2" ? "sha" : null,
	);
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-caabcd-3",
		"main",
	);
	expect(adapters.remote).toHaveBeenCalledWith(
		"test-only",
		"owner/repo",
		"ytimesy/fix-parser-caabcd-2",
	);
});
it("branches a new chat from the project's base-branch setting, not the repository default", async () => {
	adapters.project.mockResolvedValue({
		id: input.projectId,
		fullName: "owner/repo",
		branch: "develop",
		installationId: 1,
		repositoryId: 2,
	});
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-caabcd",
		"develop",
	);
});
it("treats a failed GitHub branch lookup as free rather than failing the send", async () => {
	adapters.remote.mockRejectedValue(new Error("GitHub unavailable"));
	await commitChatBranchForSubmission(input);
	expect(adapters.working.mock.calls[0][2]).toBe("ytimesy/fix-parser-caabcd");
});
