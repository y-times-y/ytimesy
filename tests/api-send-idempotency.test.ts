import { beforeEach, expect, it, vi } from "vitest";
import type { SessionItem } from "#/domain/session-item";
import { sendApiWorkspaceTask } from "#/server/services/api-workspace-session";

const connectionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const routeId = `api/${connectionId}/gpt-test`;
const fake = vi.hoisted(() => ({
	owner: vi.fn(),
	enqueue: vi.fn(async () => {}),
	holding: vi.fn(async (): Promise<string | null> => null),
	open: vi.fn(),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: fake.owner,
	chatHoldingSend: fake.holding,
	releasingChatClaimOnFailure: (
		_user: string,
		_session: string,
		_text: string,
		send: () => Promise<unknown>,
	) => send(),
	titleUntitledAgentSession: vi.fn(async () => undefined),
}));
vi.mock("#/server/adapters/api-turns", () => ({
	enqueueApiTurn: fake.enqueue,
	inheritedApiTurnSettings: vi.fn(async () => ({})),
	previousTurnMessages: vi.fn(async () => null),
}));
vi.mock("#/server/adapters/model-connections", () => ({
	listModelConnections: vi.fn(async () => []),
	loadModelConnection: vi.fn(async () => ({
		id: connectionId,
		revision: "r1",
		provider: "openai",
	})),
}));
vi.mock("#/server/services/model-connections", () => ({
	availableApiModelRoutes: vi.fn(async () => [{ id: routeId, label: "Test" }]),
}));
vi.mock("#/server/services/message-attachments", () => ({
	storeMessageAttachments: vi.fn(async () => []),
}));
vi.mock("#/server/services/agent-session-machine", () => ({
	openAgentSession: fake.open,
}));
vi.mock("#/server/services/cancel-server-turn", () => ({
	cancelServerTurn: vi.fn(),
}));

const sent: SessionItem[] = [
	{
		kind: "userMessage",
		id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" as SessionItem["id"],
		text: "continue",
	},
	{ kind: "agentMessage", id: "a1" as SessionItem["id"], text: "Done." },
];
const scope = { userId: "u1", projectId: "p1", sessionId: "s1" };

beforeEach(() => {
	fake.enqueue.mockClear();
	fake.holding.mockReset().mockResolvedValue(null);
	fake.open.mockReset();
	fake.owner.mockResolvedValue({
		id: "s1",
		projectId: "p1",
		items: sent,
		turnStatus: "completed",
		harness: "api",
	});
});

it("queues the same words sent again as a new message", async () => {
	await sendApiWorkspaceTask(scope, {
		text: "continue",
		modelId: routeId,
		idempotencyKey: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
	});
	expect(fake.enqueue).toHaveBeenCalledOnce();
	const [{ items }] = fake.enqueue.mock.calls[0] as unknown as [
		{ items: SessionItem[] },
	];
	expect(
		items.filter((item) => item.kind === "userMessage").map((item) => item.id),
	).toEqual([
		"6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		"7c9e6679-7425-40de-944b-e07fc1f90ae7",
	]);
});

it("does not queue a replayed send twice", async () => {
	await sendApiWorkspaceTask(scope, {
		text: "continue",
		modelId: routeId,
		idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
	});
	expect(fake.enqueue).not.toHaveBeenCalled();
});

it("lands a resent first message in the chat it already opened", async () => {
	fake.holding.mockResolvedValue("s1");
	const view = await sendApiWorkspaceTask(
		{ userId: "u1", projectId: "p1" },
		{
			text: "continue",
			modelId: routeId,
			idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		},
	);
	expect(fake.holding).toHaveBeenCalledWith(
		"u1",
		"p1",
		"6ba7b810-9dad-11d1-80b4-00c04fd430c8",
	);
	expect(fake.open).not.toHaveBeenCalled();
	expect(fake.enqueue).not.toHaveBeenCalled();
	expect(view.agentSessionId).toBe("s1");
});

it("opens a chat for a first message that never landed", async () => {
	fake.open.mockResolvedValue({ id: "s1" });
	await sendApiWorkspaceTask(
		{ userId: "u1", projectId: "p1" },
		{
			text: "start",
			modelId: routeId,
			idempotencyKey: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
		},
	);
	expect(fake.open).toHaveBeenCalledOnce();
	expect(fake.enqueue).toHaveBeenCalledOnce();
});
