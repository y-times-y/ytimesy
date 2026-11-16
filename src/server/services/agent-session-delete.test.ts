import { expect, it, vi } from "vitest";

/** Deleting a chat reads its tree's ids, machines and roles, never a transcript. */
const mocks = vi.hoisted(() => ({
	descendants: vi.fn(),
	cancel: vi.fn(async (_userId: string, _sessionId: string) => {}),
	deleted: vi.fn(async () => {}),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: async () => ({
		id: "chat",
		userId: "owner",
		projectId: "project",
		parentSessionId: null,
		providerRef: "vm-chat",
		agentRole: null,
	}),
	descendantAgentSessionMetadata: mocks.descendants,
	descendantAgentSessions: () => {
		throw new Error("Deleting a chat must not read its helpers' transcripts.");
	},
	deleteAgentSessionForOwner: mocks.deleted,
	providerRefsHeldOutside: async () => new Set<string>(),
}));
vi.mock("#/server/adapters/workspaces", () => ({
	workspaceForProject: async () => ({ providerRef: "template" }),
	saveTemplateSnapshot: vi.fn(),
}));
vi.mock("./cancel-server-turn", () => ({ cancelServerTurn: mocks.cancel }));
vi.mock("../adapters/checkpoints/storage", () => ({
	checkpointStorageConfigured: () => false,
	removeChatObjects: vi.fn(),
}));
vi.mock("../adapters/realtime-delivery", () => ({
	purgeConversationState: async () => {},
}));
vi.mock("../adapters/account-deletion", () => ({
	chatCleanupTargets: async () => ({ vmIds: [], snapshotIds: [] }),
}));
vi.mock("../adapters/machine-prewarm", () => ({
	prewarmedMachine: async () => null,
}));

const { deleteAgentSessionMachine } = await import("./agent-session-machine");

it("stops and removes a chat's helpers from their metadata alone", async () => {
	mocks.descendants.mockResolvedValue([
		{
			id: "writer",
			parentSessionId: "chat",
			providerRef: "vm-writer",
			agentRole: "writer",
		},
		{
			id: "reader",
			parentSessionId: "chat",
			providerRef: "vm-chat",
			agentRole: "researcher",
		},
	]);
	const destroy = vi.fn(async (_vm: string) => {});
	await deleteAgentSessionMachine(
		{ destroy, destroySnapshot: vi.fn() } as never,
		{ userId: "owner", projectId: "project", sessionId: "chat" },
	);
	expect(mocks.descendants).toHaveBeenCalledWith("owner", "chat");
	expect(mocks.cancel.mock.calls.map((call) => call[1])).toEqual([
		"chat",
		"writer",
		"reader",
	]);
	// The reader shares its parent's VM: only the chat's and the writer's go.
	expect(destroy.mock.calls.map((call) => call[0]).sort()).toEqual([
		"vm-chat",
		"vm-writer",
	]);
	expect(mocks.deleted).toHaveBeenCalledWith("owner", "chat");
});
