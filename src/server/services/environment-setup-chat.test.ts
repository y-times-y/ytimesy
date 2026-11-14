import { beforeEach, expect, it, vi } from "vitest";
import { ENVIRONMENT_SETUP_PROMPT } from "#/domain/environment-setup";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { commitChatBranchForSubmission } from "./session-branch";

/** A chat started by project setup is marked at its first send. */
const store = vi.hoisted(() => ({
	chat: null as AgentSessionRecord | null,
	mark: vi.fn(async () => true),
}));
vi.mock("#/server/adapters/environment-setup-chats", () => ({
	markEnvironmentSetupChat: store.mark,
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: async () => store.chat,
	agentSessionMetadataForOwner: async (user: string, id: string) => {
		const chat = (await (async () => store.chat)(user, id)) as {
			items?: unknown;
		} | null;
		return chat && { ...chat, items: null };
	},
	sessionHoldsUserMessage: async (
		user: string,
		id: string,
		messageId?: string,
	) => {
		const chat = (await (async () => store.chat)(user, id)) as {
			items?: unknown;
		} | null;
		return (Array.isArray(chat?.items) ? chat.items : []).some(
			(item: { kind?: string; id?: string }) =>
				item.kind === "userMessage" && (!messageId || item.id === messageId),
		);
	},
	agentSessionPageForOwner: async (user: string, id: string) => {
		const chat = (await (async () => store.chat)(user, id)) as {
			items?: unknown;
		} | null;
		return (
			chat && {
				...chat,
				items: Array.isArray(chat.items) ? chat.items : [],
				hasOlderItems: false,
				pageFound: true,
			}
		);
	},
	projectBranchHeldByOtherSession: async () => false,
	saveSessionWorkingBranch: async (
		_user: string,
		_id: string,
		branch: string,
		baseBranch?: string,
	) => {
		if (!store.chat) throw new Error("missing chat");
		store.chat = {
			...store.chat,
			selectedBranch: branch,
			workingBranch: branch,
			baseBranch: baseBranch ?? null,
		};
		return store.chat;
	},
}));
vi.mock("#/server/adapters/projects", () => ({
	projectForOwner: async () => ({
		id: "project-1",
		fullName: "acme/app",
		installationId: 1,
		repositoryId: 2,
		branch: "main",
	}),
}));
vi.mock("#/server/auth/github-connection", () => ({
	githubAccessToken: async () => "user-token",
}));
vi.mock("#/server/adapters/github", () => ({
	authorizedRepository: async () => ({
		installationId: 1,
		repositoryId: 2,
		fullName: "acme/app",
		defaultBranch: "main",
	}),
	repositoryBranchSha: async (_token: string, _repo: string, ref: string) =>
		ref === "main" ? "a".repeat(40) : null,
}));

const newChat = {
	id: "a1b2c3d4",
	userId: "alice",
	projectId: "project-1",
	parentSessionId: null,
	turnStatus: "idle",
	items: [],
	title: "New session",
	selectedBranch: null,
	workingBranch: null,
	baseBranch: null,
} as unknown as AgentSessionRecord;

beforeEach(() => {
	store.chat = { ...newChat };
	store.mark.mockClear();
});

it("marks a chat sent from the setup chip and names its branch after setup", async () => {
	const text = `${ENVIRONMENT_SETUP_PROMPT} Use port 4000.`;
	const chat = await commitChatBranchForSubmission({
		userId: "alice",
		projectId: "project-1",
		sessionId: newChat.id,
		text,
		environmentSetup: true,
	});
	expect(store.mark).toHaveBeenCalledWith(
		"alice",
		newChat.id,
		expect.stringMatching(/^Set up this project/),
	);
	expect(chat.workingBranch).toBe("ytimesy/set-up-project-b2c3d4");
});

it("leaves an ordinary chat unmarked", async () => {
	await commitChatBranchForSubmission({
		userId: "alice",
		projectId: "project-1",
		sessionId: newChat.id,
		text: "Fix the parser",
	});
	expect(store.mark).not.toHaveBeenCalled();
});
