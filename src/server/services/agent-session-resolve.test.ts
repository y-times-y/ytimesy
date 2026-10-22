import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workspace: vi.fn(),
	session: vi.fn(),
	list: vi.fn(),
	insert: vi.fn(),
	reusable: vi.fn(),
}));
vi.mock("#/server/adapters/workspaces", () => ({
	workspaceForProject: mocks.workspace,
	saveTemplateSnapshot: vi.fn(),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
	listAgentSessions: mocks.list,
	insertAgentSession: mocks.insert,
	reusableEmptyChat: mocks.reusable,
	childAgentSession: vi.fn(),
	deleteAgentSessionForOwner: vi.fn(),
	descendantAgentSessions: vi.fn(),
	providerRefsHeldOutside: vi.fn(),
	saveAgentSessionProviderRef: vi.fn(),
	selectAgentSessionHarness: vi.fn(),
}));
vi.mock("#/domain/project-workspace", () => ({
	workspaceEnvironmentIsReady: () => true,
}));

const { bindAgentSessionMachine, openAgentSession, peekAgentSessionMachine } =
	await import("./agent-session-machine");

const chat = {
	id: "chat",
	userId: "owner",
	projectId: "project",
	harness: "api",
	providerRef: "vm-1",
	parentSessionId: null,
	listedModelId: null,
	items: [],
};
beforeEach(() => {
	mocks.workspace.mockReset().mockResolvedValue({
		id: "workspace",
		providerRef: "template",
		templateSnapshotId: "snap",
	});
	mocks.session.mockReset().mockResolvedValue(chat);
	mocks.list.mockReset().mockResolvedValue([chat]);
	mocks.insert.mockReset().mockImplementation(async (input) => ({
		...chat,
		id: "new",
		providerRef: null,
		listedModelId: input.listedModelId,
	}));
	mocks.reusable.mockReset().mockResolvedValue(null);
});

it("binds a named chat from its own row, never the project's chat list", async () => {
	const ensureRunning = vi.fn(async () => {});
	const bound = await bindAgentSessionMachine(
		{
			restoreRetainedSession: async () => "vm-1",
			ensureRunning,
		} as never,
		{
			userId: "owner",
			projectId: "project",
			harness: "api",
			sessionId: "chat",
		},
	);
	expect(bound.providerRef).toBe("vm-1");
	expect(mocks.session).toHaveBeenCalledWith("owner", "chat");
	expect(mocks.list).not.toHaveBeenCalled();
});

it("still refuses a named chat that is missing or in another project", async () => {
	const machines = { ensureRunning: vi.fn() } as never;
	const input = {
		userId: "owner",
		projectId: "project",
		harness: "api",
		sessionId: "chat",
	} as const;
	mocks.session.mockResolvedValueOnce(null);
	await expect(bindAgentSessionMachine(machines, input)).rejects.toThrow(
		"Agent session is not available.",
	);
	mocks.session.mockResolvedValueOnce({ ...chat, projectId: "other" });
	await expect(bindAgentSessionMachine(machines, input)).rejects.toThrow(
		"Agent session is not in this project.",
	);
});

it("reads the chat list for the model a new chat inherits", async () => {
	mocks.list.mockResolvedValue([
		{ ...chat, listedModelId: "api/connection/model" },
	]);
	await openAgentSession({
		userId: "owner",
		projectId: "project",
		harness: "api",
	});
	expect(mocks.list).toHaveBeenCalledOnce();
	expect(mocks.insert).toHaveBeenCalledWith(
		expect.objectContaining({ listedModelId: "api/connection/model" }),
	);
});

it("peeks a named chat by id and the latest chat from the list", async () => {
	expect(
		await peekAgentSessionMachine({
			userId: "owner",
			projectId: "project",
			sessionId: "chat",
		}),
	).toEqual({ session: chat, providerRef: "vm-1" });
	expect(mocks.list).not.toHaveBeenCalled();
	expect(
		(await peekAgentSessionMachine({ userId: "owner", projectId: "project" }))
			.session,
	).toBe(chat);
	expect(mocks.list).toHaveBeenCalledOnce();
});
