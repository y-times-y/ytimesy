import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	title: vi.fn(),
	enqueue: vi.fn(),
	previous: vi.fn(),
	inherited: vi.fn(),
	catalog: vi.fn(),
	auth: vi.fn(),
	account: vi.fn(),
	open: vi.fn(),
	commitBranch: vi.fn(),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
	chatHoldingSend: vi.fn(),
	releasingChatClaimOnFailure: vi.fn(
		(_user: string, _id: string, _text: string, send: () => unknown) => send(),
	),
	titleUntitledAgentSession: mocks.title,
}));
vi.mock("#/server/adapters/api-turns", () => ({
	enqueueApiTurn: mocks.enqueue,
	inheritedSubscriptionSettings: mocks.inherited,
	previousTurnMessages: mocks.previous,
}));
vi.mock("#/server/adapters/codex-subscription", () => ({
	codexSubscriptionCatalog: mocks.catalog,
}));
vi.mock("#/server/auth/agent-account", () => ({
	loadAgentAccount: mocks.account,
	// One read of the account row: its status and whether its login is usable.
	loadAgentAccountState: async (userId: string) => ({
		account: await mocks.account(userId),
		managed: await mocks.auth(userId),
		sealedDeviceLogin: null,
	}),
}));
vi.mock("#/server/auth/codex-managed-auth", () => ({
	hasManagedCodexAuth: mocks.auth,
}));
vi.mock("#/server/auth/codex-device-login", () => ({
	readCodexDeviceLogin: vi.fn(),
	deviceLoginFromSealed: vi.fn(),
	startCodexDeviceLogin: vi.fn(),
}));
vi.mock("#/server/services/agent-session-machine", () => ({
	openAgentSession: mocks.open,
}));
vi.mock("#/server/services/session-branch", () => ({
	commitChatBranchForSubmission: mocks.commitBranch,
}));
vi.mock("#/server/services/cancel-server-turn", () => ({
	cancelServerTurn: vi.fn(),
}));
vi.mock("#/server/services/message-attachments", () => ({
	storeMessageAttachments: vi.fn(async () => []),
}));
vi.mock("#/server/services/model-failover", () => ({
	pinnedTurnFailover: vi.fn(),
}));

import { withAfterResponse } from "#/server/adapters/after-response";
import { sendSubscriptionTask } from "#/server/services/codex-subscription-session";

const scope = { userId: "u", projectId: "p", sessionId: "s" };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue({
		id: "s",
		projectId: "p",
		harness: "codex",
		listedModelId: "old",
		turnStatus: "completed",
		items: [{ kind: "agentMessage", id: "a1", text: "earlier" }],
	});
	mocks.auth.mockResolvedValue(true);
	mocks.catalog.mockResolvedValue([{ id: "model", label: "model" }]);
	mocks.account.mockResolvedValue({
		status: "connected",
		planType: "plus",
		email: null,
	});
	mocks.inherited.mockResolvedValue(null);
	mocks.previous.mockResolvedValue(null);
	mocks.enqueue.mockResolvedValue(undefined);
	mocks.title.mockResolvedValue(undefined);
});

it("answers a send with the committed chat, without reading the chat again", async () => {
	const view = await sendSubscriptionTask(scope, {
		text: "hello",
		modelId: "model",
		idempotencyKey: "00000000-0000-4000-8000-000000000009",
	});
	expect(mocks.session).toHaveBeenCalledOnce();
	expect(mocks.account).toHaveBeenCalledOnce();
	expect(view).toMatchObject({
		agentSessionId: "s",
		turnStatus: "running",
		listedModelId: "model",
		canSend: true,
		items: [
			{ kind: "agentMessage", text: "earlier" },
			{
				kind: "userMessage",
				id: "00000000-0000-4000-8000-000000000009",
				text: "hello",
			},
		],
	});
	expect(mocks.enqueue.mock.calls[0][0].items).toEqual(view.items);
});

it("titles an untitled chat after a web send's response", async () => {
	const deferred: Promise<unknown>[] = [];
	await withAfterResponse(
		(work) => {
			deferred.push(work);
		},
		() => sendSubscriptionTask(scope, { text: "hello", modelId: "model" }),
	);
	expect(deferred).toHaveLength(1);
	await Promise.all(deferred);
	expect(mocks.title).toHaveBeenCalledWith("u", "s", expect.any(String));
});

it("refuses a chat from another project before queueing anything", async () => {
	await expect(
		sendSubscriptionTask(
			{ ...scope, projectId: "other" },
			{ text: "hello", modelId: "model" },
		),
	).rejects.toThrow("Session is not in this project.");
	expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("commits a composer draft's new chat branch before queueing its turn", async () => {
	const opened = { id: "s", projectId: "p", harness: "codex", items: [] };
	mocks.open.mockResolvedValue(opened);
	mocks.commitBranch.mockImplementation(async () => {
		expect(mocks.enqueue).not.toHaveBeenCalled();
		return { ...opened, workingBranch: "ytimesy/hello-s" };
	});
	const view = await sendSubscriptionTask(
		{ userId: "u", projectId: "p" },
		{ text: "hello", modelId: "model" },
	);
	expect(mocks.open).toHaveBeenCalledWith(
		expect.objectContaining({ userId: "u", projectId: "p", harness: "codex" }),
	);
	expect(mocks.commitBranch).toHaveBeenCalledWith({
		userId: "u",
		projectId: "p",
		sessionId: "s",
		text: "hello",
		session: opened,
	});
	expect(mocks.enqueue).toHaveBeenCalledOnce();
	// The chat as opened, then as its branch commit left it: never read again.
	expect(mocks.session).not.toHaveBeenCalled();
	expect(view).toMatchObject({
		agentSessionId: "s",
		selectedBranch: "ytimesy/hello-s",
	});
});
