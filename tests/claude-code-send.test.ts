import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	apiModelCatalog,
	sendApiWorkspaceTask,
} from "#/server/services/api-workspace-session";

const connectionId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const routeId = `api/${connectionId}/gpt-test`;
const fake = vi.hoisted(() => ({
	owner: vi.fn(),
	enqueue: vi.fn(async (_input: Record<string, unknown>) => {}),
	connected: vi.fn(async () => true),
	refused: vi.fn(async () => false),
	failover: vi.fn(async () => true),
}));
vi.mock("#/server/adapters/model-failover-preferences", () => ({
	loadModelFailoverPreferences: async () => ({
		enabled: await fake.failover(),
		askBeforePaid: false,
		connectionOrder: [],
	}),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: fake.owner,
	chatHoldingSend: vi.fn(async () => null),
	releasingChatClaimOnFailure: (
		_user: string,
		_session: string,
		_text: string,
		send: () => Promise<unknown>,
	) => send(),
	titleUntitledAgentSession: vi.fn(async () => undefined),
	descendantAgentSessions: vi.fn(async () => []),
}));
vi.mock("#/server/adapters/api-turns", () => ({
	enqueueApiTurn: fake.enqueue,
	inheritedApiTurnSettings: vi.fn(async () => ({})),
	previousTurnMessages: vi.fn(async () => null),
}));
vi.mock("#/server/adapters/claude-subscription", () => ({
	hasClaudeSubscription: fake.connected,
	claudeSubscriptionStatus: async () => ({
		status: (await fake.connected())
			? "connected"
			: (await fake.refused())
				? "refused"
				: "disconnected",
	}),
}));
vi.mock("#/server/adapters/model-connections", () => ({
	listModelConnections: vi.fn(async () => []),
	loadModelConnection: vi.fn(),
}));
vi.mock("#/server/services/model-connections", () => ({
	availableApiModelRoutes: vi.fn(async () => [{ id: routeId, label: "Test" }]),
}));
vi.mock("#/server/services/message-attachments", () => ({
	storeMessageAttachments: vi.fn(async () => []),
}));
vi.mock("#/server/services/agent-session-machine", () => ({
	openAgentSession: vi.fn(),
}));
vi.mock("#/server/services/session-branch", () => ({
	commitChatBranchForSubmission: vi.fn(),
}));
vi.mock("#/server/services/cancel-server-turn", () => ({
	cancelServerTurn: vi.fn(),
}));

const scope = { userId: "u1", projectId: "p1", sessionId: "s1" };

beforeEach(() => {
	process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED = "1";
	fake.enqueue.mockClear();
	fake.connected.mockReset().mockResolvedValue(true);
	fake.refused.mockReset().mockResolvedValue(false);
	fake.failover.mockReset().mockResolvedValue(true);
	fake.owner.mockResolvedValue({
		id: "s1",
		projectId: "p1",
		items: [],
		turnStatus: "idle",
		harness: "api",
	});
});
afterEach(() => {
	delete process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED;
});

it("lists Claude Code beside API keys only when switched on and connected", async () => {
	expect((await apiModelCatalog("u1")).map((model) => model.id)).toEqual([
		"claude-code/claude-opus-5-5",
		"claude-code/claude-sonnet-5-5",
		"claude-code/claude-haiku-5-5",
		"claude-code/claude-fable-5-2",
		"claude-code/claude-fable-5-1",
		routeId,
	]);
	fake.connected.mockResolvedValue(false);
	expect((await apiModelCatalog("u1")).map((model) => model.id)).toEqual([
		routeId,
	]);
	fake.connected.mockResolvedValue(true);
	delete process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED;
	expect((await apiModelCatalog("u1")).map((model) => model.id)).toEqual([
		routeId,
	]);
	expect(fake.connected).toHaveBeenCalledTimes(2);
});

it("queues a Claude Code turn on the subscription, with no API connection", async () => {
	const view = await sendApiWorkspaceTask(scope, {
		text: "Fix the bug",
		modelId: "claude-code/claude-opus-5-5",
		idempotencyKey: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
	});
	expect(fake.enqueue).toHaveBeenCalledOnce();
	expect(fake.enqueue.mock.calls[0]?.[0]).toMatchObject({
		connectionId: null,
		revision: "claude-code:v1:{}",
		modelId: "claude-opus-5-5",
		routeId: "claude-code/claude-opus-5-5",
	});
	expect(view).toMatchObject({
		turnStatus: "running",
		listedModelId: "claude-code/claude-opus-5-5",
	});
});

it("starts a subagent on Claude Code the same way (a prepared task)", async () => {
	fake.owner.mockResolvedValue({
		id: "s1",
		projectId: "p1",
		items: [],
		turnStatus: "running",
		harness: "api",
		parentSessionId: "parent",
		listedModelId: "claude-code/claude-sonnet-5-5",
	});
	await sendApiWorkspaceTask(
		scope,
		{
			text: "Brief: read the auth code.",
			modelId: "claude-code/claude-sonnet-5-5",
		},
		true,
	);
	expect(fake.enqueue.mock.calls[0]?.[0]).toMatchObject({
		connectionId: null,
		modelId: "claude-sonnet-5-5",
		preparedTask: true,
	});
});

it("refuses a Claude Code send while switched off or not connected", async () => {
	fake.connected.mockResolvedValue(false);
	await expect(
		sendApiWorkspaceTask(scope, {
			text: "x",
			modelId: "claude-code/claude-opus-5-5",
		}),
	).rejects.toThrow(/Settings > Agents/);
	delete process.env.YTIMESY_CLAUDE_SUBSCRIPTION_ENABLED;
	await expect(
		sendApiWorkspaceTask(scope, {
			text: "x",
			modelId: "claude-code/claude-opus-5-5",
		}),
	).rejects.toThrow(/not available/);
	expect(fake.enqueue).not.toHaveBeenCalled();
});

it("sends on a refused Claude token while failover is on: the turn moves elsewhere", async () => {
	fake.connected.mockResolvedValue(false);
	fake.refused.mockResolvedValue(true);
	expect((await apiModelCatalog("u1")).map((model) => model.id)).toContain(
		"claude-code/claude-opus-5-5",
	);
	const view = await sendApiWorkspaceTask(scope, {
		text: "Reply with just the word OK.",
		modelId: "claude-code/claude-opus-5-5",
	});
	expect(fake.enqueue.mock.calls[0]?.[0]).toMatchObject({
		revision: "claude-code:v1:{}",
		routeId: "claude-code/claude-opus-5-5",
	});
	expect(view.listedModelId).toBe("claude-code/claude-opus-5-5");
	// With failover off, the token must be renewed first.
	fake.failover.mockResolvedValue(false);
	expect((await apiModelCatalog("u1")).map((model) => model.id)).toEqual([
		routeId,
	]);
	await expect(
		sendApiWorkspaceTask(scope, {
			text: "x",
			modelId: "claude-code/claude-opus-5-5",
		}),
	).rejects.toThrow(/Settings > Agents/);
});
