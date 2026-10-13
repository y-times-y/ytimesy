import { beforeEach, expect, it, vi } from "vitest";
import { commitChatBranchForSubmission } from "../src/server/services/session-branch";

const adapters = vi.hoisted(() => ({
	session: vi.fn(),
	project: vi.fn(),
	selection: vi.fn(),
	working: vi.fn(),
	branch: vi.fn(),
	repository: vi.fn(),
}));
vi.mock("../src/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: adapters.session,
	saveSessionBranchSelection: adapters.selection,
	saveSessionWorkingBranch: adapters.working,
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: adapters.project,
}));
vi.mock("../src/server/adapters/github", () => ({
	authorizedRepository: adapters.repository,
	githubClient: () => ({ repos: { getBranch: adapters.branch } }),
}));
vi.mock("../src/server/auth/github-connection", () => ({
	githubAccessToken: async () => "test-only",
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
	adapters.repository.mockResolvedValue({ defaultBranch: "main" });
});
it("generates a task-specific branch only on first submission", async () => {
	await commitChatBranchForSubmission(input);
	expect(adapters.working).toHaveBeenCalledWith(
		"alice",
		"chat-abcd",
		"ytimesy/fix-parser-abcd",
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
		"ytimesy/fix-parser-abcd",
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
		"ytimesy/fix-parser-abcd",
		"main",
	);
});
it("switching an existing chat to main does not rename main", async () => {
	adapters.session.mockResolvedValue({
		id: input.sessionId,
		projectId: input.projectId,
		turnStatus: "completed",
		workingBranch: "ytimesy/fix-parser-abcd",
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
