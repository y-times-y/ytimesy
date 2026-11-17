import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ENVIRONMENT_SETUP_PROMPT,
	initialSetupMessageId,
} from "#/domain/environment-setup";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	queue: vi.fn(),
	queued: vi.fn(async () => [] as unknown[]),
	take: vi.fn(),
	restore: vi.fn(async (..._args: unknown[]) => {}),
	remove: vi.fn(async () => true),
	update: vi.fn(async () => true),
	release: vi.fn(
		async (): Promise<
			| { status: "running" }
			| { status: "taken"; send: Record<string, unknown> }
			| { status: "missing" }
		> => ({ status: "running" }),
	),
	send: vi.fn(),
	read: vi.fn(),
	stop: vi.fn(),
	store: vi.fn(async () => [] as unknown[]),
	workspace: vi.fn(),
	hold: vi.fn(async (..._args: unknown[]) => true),
	releaseHeld: vi.fn(async () => true),
	holding: vi.fn(async () => null as string | null),
	releasable: vi.fn(async () => [] as unknown[]),
	claim: vi.fn(async () => true),
	reusable: vi.fn(async () => null as unknown),
	insert: vi.fn(),
	dispatch: vi.fn(async (_job: unknown) => true),
	markSetup: vi.fn(async (..._args: unknown[]) => true),
	otherSetup: vi.fn(async (..._args: unknown[]) => null as string | null),
	claimSetup: vi.fn(async (..._args: unknown[]) => null as unknown),
}));
vi.mock("../jobs/conversation-delivery", () => ({
	relayConversationDeliveriesOnce: vi.fn(async () => undefined),
}));
vi.mock("../adapters/environment-setup-chats", () => ({
	markEnvironmentSetupChat: mocks.markSetup,
	otherProjectSetupChat: mocks.otherSetup,
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
	agentSessionMetadataForOwner: mocks.session,
	sessionHoldsUserMessage: async (
		user: string,
		id: string,
		messageId?: string,
	) => {
		const chat = (await mocks.session(user, id)) as { items?: unknown } | null;
		return (Array.isArray(chat?.items) ? chat.items : []).some(
			(item: { kind?: string; id?: string }) =>
				item.kind === "userMessage" && (!messageId || item.id === messageId),
		);
	},
	agentSessionPageForOwner: vi.fn(async () => null),
	claimChatForSend: mocks.claim,
	reusableEmptyChat: mocks.reusable,
	insertAgentSession: mocks.insert,
	claimInitialSetupChat: mocks.claimSetup,
}));
vi.mock("../adapters/workspaces", () => ({
	workspaceForProject: mocks.workspace,
}));
vi.mock("../adapters/background-job-dispatch", () => ({
	backgroundJobId: (key: string) => `job:${key}`,
	dispatchBackgroundJob: mocks.dispatch,
}));
vi.mock("../adapters/queued-user-messages", () => ({
	queueUserMessageWhileRunning: mocks.queue,
	queuedUserMessageItems: mocks.queued,
	takeNextQueuedUserMessage: mocks.take,
	// The turn-end drain takes a batch; a mocked single send is a batch of one.
	takeNextQueuedUserMessages: async (...args: unknown[]) => {
		const taken = await (mocks.take as (...a: unknown[]) => unknown)(...args);
		return Array.isArray(taken) ? taken : taken ? [taken] : [];
	},
	restoreQueuedUserMessage: mocks.restore,
	restoreQueuedUserMessages: async (id: string, sends: unknown[]) => {
		for (const send of sends) await mocks.restore(id, send);
	},
	removeQueuedUserMessage: mocks.remove,
	updateQueuedUserMessage: mocks.update,
	releaseQueuedUserMessage: mocks.release,
	holdUserMessageForSetup: mocks.hold,
	releaseHeldUserMessages: mocks.releaseHeld,
	chatHoldingMessage: mocks.holding,
	chatsWithReleasableHeldSends: mocks.releasable,
}));
vi.mock("./harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: mocks.send,
	readHarnessWorkspaceSession: mocks.read,
	stopHarnessWorkspaceTurn: mocks.stop,
}));
vi.mock("./message-attachments", () => ({
	storeMessageAttachments: mocks.store,
}));

const {
	deliverHeldSends,
	dispatchReleasableHeldSends,
	releaseQueuedComposerMessage,
	removeQueuedComposerMessage,
	sendComposerMessage,
	startQueuedUserTurn,
	stopTurnKeepingQueue,
	updateQueuedComposerMessage,
} = await import("./queued-user-messages");

const machines = {} as WorkspaceMachines;
const scope = {
	userId: "owner",
	projectId: "project",
	sessionId: "chat",
	harnessId: "api" as const,
};
const messageId = "11111111-1111-4111-8111-111111111111";
const readyWorkspace = {
	id: "workspace",
	status: "ready",
	providerRef: "vm",
	templateSnapshotId: "snap",
};
const view = (turnStatus = "running", items: unknown[] = []) => ({
	agentSessionId: "chat",
	items,
	turnStatus,
	connection: { status: "authenticated" },
});

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.queued.mockResolvedValue([]);
	mocks.store.mockResolvedValue([]);
	mocks.remove.mockResolvedValue(true);
	mocks.update.mockResolvedValue(true);
	mocks.release.mockResolvedValue({ status: "running" });
	mocks.read.mockReturnValue(Effect.succeed(view()));
	mocks.send.mockReturnValue(Effect.succeed(view()));
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "running",
		items: [],
	});
	mocks.queue.mockResolvedValue("queued");
	mocks.workspace.mockResolvedValue(readyWorkspace);
	mocks.hold.mockResolvedValue(true);
	mocks.releaseHeld.mockResolvedValue(true);
	mocks.holding.mockResolvedValue(null);
	mocks.releasable.mockResolvedValue([]);
	mocks.claim.mockResolvedValue(true);
	mocks.reusable.mockResolvedValue(null);
	mocks.dispatch.mockResolvedValue(true);
	mocks.markSetup.mockResolvedValue(true);
	mocks.otherSetup.mockResolvedValue(null);
});

it("queues a send behind the running turn instead of rejecting it", async () => {
	const attachment = {
		id: "22222222-2222-4222-8222-222222222222",
		name: "shot.png",
		mediaType: "image/png",
		size: 10,
	};
	mocks.store.mockResolvedValue([attachment]);
	mocks.queued.mockResolvedValue([
		{ kind: "userMessage", id: messageId, text: "Also the README" },
	]);
	const result = await Effect.runPromise(
		sendComposerMessage(machines, scope, {
			text: " Also the README ",
			modelId: "connection|model",
			speed: "fast",
			idempotencyKey: messageId,
			attachments: [{ name: "shot.png", mediaType: "image/png", base64: "" }],
		}),
	);
	expect(mocks.send).not.toHaveBeenCalled();
	const [, , queued] = mocks.queue.mock.calls[0];
	expect(queued).toMatchObject({
		item: {
			kind: "userMessage",
			id: messageId,
			text: "Also the README",
			attachments: [attachment],
		},
		harnessId: "api",
		modelId: "connection|model",
		speed: "fast",
		released: false,
	});
	expect(queued.message).toContain("Also the README");
	expect(queued.message).toContain("/tmp/ytimesy-attachments/");
	expect(result.items).toEqual([
		expect.objectContaining({ id: messageId, queued: true }),
	]);
});

it("refuses a send past the per-chat cap with a clear error and starts nothing", async () => {
	mocks.queue.mockResolvedValueOnce("full");
	await expect(
		Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "one more",
				modelId: "connection|model",
				idempotencyKey: messageId,
			}),
		),
	).rejects.toThrow("already has 50 messages waiting");
	expect(mocks.send).not.toHaveBeenCalled();
});

it("starts an agent's queued message (agent_send queue) with the text the model reads, a person's with its own text", async () => {
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	});
	const steering =
		"Message from Main (root):\n\nUse port 4001.\n\nCoordination message ID: root:req";
	mocks.take.mockResolvedValueOnce({
		item: { kind: "userMessage", id: "root:req", text: steering },
		message: `${steering}\n\nThis is your parent agent steering your brief.`,
		harnessId: "api",
		modelId: "model",
	});
	await startQueuedUserTurn(machines, "owner", "chat");
	expect(mocks.send.mock.calls.at(-1)?.[2]).toMatchObject({
		text: steering,
		runtimeText: `${steering}\n\nThis is your parent agent steering your brief.`,
	});
	mocks.take.mockResolvedValueOnce({
		item: { kind: "userMessage", id: messageId, text: "Then deploy" },
		message: "Then deploy\n\nNote",
		harnessId: "api",
		modelId: "model",
	});
	await startQueuedUserTurn(machines, "owner", "chat");
	expect(mocks.send.mock.calls.at(-1)?.[2]).not.toHaveProperty("runtimeText");
});

it("starts a turn with the stored files when the turn ended before the send queued", async () => {
	const attachment = {
		id: "22222222-2222-4222-8222-222222222222",
		name: "a.txt",
		mediaType: "text/plain",
		size: 1,
	};
	mocks.store.mockResolvedValue([attachment]);
	mocks.queue.mockResolvedValue("not-running");
	await Effect.runPromise(
		sendComposerMessage(machines, scope, {
			text: "Next",
			modelId: "connection|model",
			idempotencyKey: messageId,
			attachments: [{ name: "a.txt", mediaType: "text/plain", base64: "" }],
		}),
	);
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		scope,
		expect.objectContaining({
			attachments: undefined,
			storedAttachments: [attachment],
		}),
		// The row read while the turn ran is stale now: the send reads it again.
		undefined,
	);
	expect(mocks.store).toHaveBeenCalledOnce();
});

it("never queues runtime sends, approvals or idle chats", async () => {
	for (const input of [
		{ runtimeText: "notice" },
		{ approvesPlan: true },
		{ continueOn: "codex|model" },
	]) {
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "x",
				modelId: "m",
				...input,
			}),
		);
	}
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	});
	await Effect.runPromise(
		sendComposerMessage(machines, scope, { text: "x", modelId: "m" }),
	);
	expect(mocks.queue).not.toHaveBeenCalled();
	expect(mocks.send).toHaveBeenCalledTimes(4);
});

it("a send while the ended turn has not yet taken its waiting message starts that message first and queues behind it", async () => {
	const waitingId = "33333333-3333-4333-8333-333333333333";
	const idle = {
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	};
	const running = { ...idle, turnStatus: "running" };
	// The chat runs once the waiting message's turn has started.
	let current = idle;
	mocks.session.mockImplementation(async () => current);
	mocks.send.mockImplementation(() => {
		current = running;
		return Effect.succeed(view());
	});
	mocks.queued.mockResolvedValue([
		{ kind: "userMessage", id: waitingId, text: "First" },
	]);
	mocks.take.mockResolvedValueOnce({
		item: { kind: "userMessage", id: waitingId, text: "First" },
		message: "First",
		harnessId: "api",
		modelId: "connection|model",
	});
	await Effect.runPromise(
		sendComposerMessage(machines, scope, {
			text: "Second",
			modelId: "connection|model",
			idempotencyKey: messageId,
		}),
	);
	// Only the waiting message started a turn; the new send waits behind it.
	expect(mocks.send).toHaveBeenCalledOnce();
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.anything(),
		expect.objectContaining({ text: "First", idempotencyKey: waitingId }),
		undefined,
	);
	expect(mocks.queue).toHaveBeenCalledWith(
		"owner",
		"chat",
		expect.objectContaining({
			item: expect.objectContaining({ id: messageId, text: "Second" }),
		}),
	);
});

it("an idle chat's send goes at once when its waiting message cannot start", async () => {
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	});
	mocks.queued.mockResolvedValue([
		{
			kind: "userMessage",
			id: "33333333-3333-4333-8333-333333333333",
			text: "First",
		},
	]);
	mocks.take.mockResolvedValue(null);
	await Effect.runPromise(
		sendComposerMessage(machines, scope, {
			text: "Second",
			modelId: "connection|model",
			idempotencyKey: messageId,
		}),
	);
	expect(mocks.queue).not.toHaveBeenCalled();
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		scope,
		expect.objectContaining({ text: "Second" }),
		// The queue check reads only the chat's row; the send reads what it needs.
		undefined,
	);
});

it("starts the next turn with the oldest waiting message and its settings", async () => {
	const attachment = {
		id: "22222222-2222-4222-8222-222222222222",
		name: "a.txt",
		mediaType: "text/plain",
		size: 1,
	};
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "codex",
		turnStatus: "idle",
		items: [],
	});
	mocks.take.mockResolvedValue({
		item: {
			kind: "userMessage",
			id: messageId,
			text: "Then deploy",
			attachments: [attachment],
		},
		message: "Then deploy",
		harnessId: "codex",
		modelId: "gpt",
		variant: "high",
		fast: true,
	});
	await startQueuedUserTurn(machines, "owner", "chat");
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ sessionId: "chat", harnessId: "codex" }),
		{
			text: "Then deploy",
			modelId: "gpt",
			variant: "high",
			fast: true,
			idempotencyKey: messageId,
			storedAttachments: [attachment],
		},
		// The queue check reads only the chat's row; the send reads what it needs.
		undefined,
	);
	expect(mocks.restore).not.toHaveBeenCalled();
});

it("puts a message back when its turn cannot start", async () => {
	const next = {
		item: { kind: "userMessage", id: messageId, text: "Then deploy" },
		message: "Then deploy",
		harnessId: "api",
		modelId: "connection|model",
	};
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	});
	mocks.take.mockResolvedValue(next);
	mocks.send.mockReturnValue(
		Effect.succeed({
			...view("idle"),
			connection: { status: "failed", message: "Model removed." },
		}),
	);
	await startQueuedUserTurn(machines, "owner", "chat");
	expect(mocks.restore).toHaveBeenCalledWith("chat", next);
	mocks.take.mockResolvedValue(null);
	mocks.send.mockClear();
	await startQueuedUserTurn(machines, "owner", "chat");
	expect(mocks.send).not.toHaveBeenCalled();
});

const batchSend = (id: string, text: string, extra = {}) => ({
	item: { kind: "userMessage", id, text, ...extra },
	message: text,
	harnessId: "api",
	modelId: "connection|model",
});
const idle = () =>
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	});

it("starts several waiting messages as one turn: the last is the send, the earlier ones keep their bubbles", async () => {
	idle();
	const a = batchSend("a", "First", { attachments: [{ id: "f1" }] });
	const b = batchSend("b", "Second");
	const c = batchSend("c", "Third");
	mocks.take.mockResolvedValue([a, b, c]);
	expect(await startQueuedUserTurn(machines, "owner", "chat")).toBe(true);
	expect(mocks.send).toHaveBeenCalledOnce();
	const [, , task] = mocks.send.mock.calls[0] as unknown[] as [
		unknown,
		unknown,
		Record<string, unknown>,
	];
	expect(task).toMatchObject({
		text: "Third",
		idempotencyKey: "c",
		merged: {
			items: [a.item, b.item],
			modelText:
				"Message 1 of 3:\nFirst\n\nMessage 2 of 3:\nSecond\n\nMessage 3 of 3:\nThird",
		},
	});
	expect(task).not.toHaveProperty("runtimeText");
	expect(mocks.restore).not.toHaveBeenCalled();
});

it("sends one waiting message as before, with no merge", async () => {
	idle();
	mocks.take.mockResolvedValue([batchSend("a", "Only")]);
	await startQueuedUserTurn(machines, "owner", "chat");
	expect(mocks.send.mock.calls[0]?.[2]).not.toHaveProperty("merged");
});

it("puts every merged message back, in order, when their turn cannot start", async () => {
	idle();
	const batch = [batchSend("a", "First"), batchSend("b", "Second")];
	mocks.take.mockResolvedValue(batch);
	mocks.send.mockReturnValue(
		Effect.succeed({
			...view("idle"),
			connection: { status: "failed", message: "Model removed." },
		}),
	);
	expect(await startQueuedUserTurn(machines, "owner", "chat")).toBe(false);
	expect(
		mocks.restore.mock.calls.map((call) => (call as unknown[])[1]),
	).toEqual(batch);
});

it("sends a merged batch of one sender's steering with the steering text as the model's text", async () => {
	idle();
	const steer = (id: string, word: string) => {
		const text = `Message from Lead (x):\n\n${word}\n\nCoordination message ID: ${id}`;
		return {
			item: { kind: "userMessage", id, text },
			message: `${text}\n\nNote`,
			harnessId: "api",
			modelId: "connection|model",
		};
	};
	mocks.take.mockResolvedValue([steer("a", "one"), steer("b", "two")]);
	await startQueuedUserTurn(machines, "owner", "chat");
	const task = mocks.send.mock.calls[0]?.[2] as Record<string, string>;
	expect(task.runtimeText).toContain("Message 1 of 2:");
	expect(task.runtimeText).toContain("Message 2 of 2:");
});

it("a merged batch never queues behind a turn that started meanwhile: it goes back whole", async () => {
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "running",
		items: [],
	});
	const batch = [batchSend("a", "First"), batchSend("b", "Second")];
	mocks.take.mockResolvedValue(batch);
	expect(await startQueuedUserTurn(machines, "owner", "chat")).toBe(false);
	expect(mocks.queue).not.toHaveBeenCalled();
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.restore).toHaveBeenCalledTimes(2);
});

it("steers a new message while a turn runs by queuing it already released", async () => {
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "running",
		items: [],
	});
	await Effect.runPromise(
		sendComposerMessage(machines, scope, {
			text: "Use the other API",
			modelId: "connection|model",
			idempotencyKey: messageId,
			released: true,
		}),
	);
	expect(mocks.queue).toHaveBeenCalledWith(
		"owner",
		"chat",
		expect.objectContaining({ released: true }),
	);
});

it("keeps queued messages through Stop and starts them once nothing runs", async () => {
	mocks.stop.mockReturnValue(Effect.succeed(undefined));
	mocks.read.mockReturnValue(Effect.succeed(view("running")));
	await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
	expect(mocks.take).not.toHaveBeenCalled();
	mocks.read.mockReturnValue(Effect.succeed(view("idle")));
	mocks.take.mockResolvedValue(null);
	await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
	expect(mocks.take).toHaveBeenCalledWith("owner", "chat");
});

it("stops before reading the chat, and reads its view once", async () => {
	const order: string[] = [];
	mocks.stop.mockImplementation(() =>
		Effect.sync(() => {
			order.push("stop");
		}),
	);
	mocks.read.mockImplementation(() =>
		Effect.sync(() => {
			order.push("read");
			return view("running");
		}),
	);
	await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
	expect(order).toEqual(["stop", "read"]);
});

it("removes a waiting message, and says so when it was already delivered", async () => {
	await Effect.runPromise(removeQueuedComposerMessage(scope, messageId));
	expect(mocks.remove).toHaveBeenCalledWith("owner", "chat", messageId);
	mocks.remove.mockResolvedValue(false);
	await expect(
		Effect.runPromise(removeQueuedComposerMessage(scope, messageId)),
	).rejects.toThrow("already delivered");
});

it("edits a waiting message in place", async () => {
	mocks.queued.mockResolvedValue([
		{ kind: "userMessage", id: messageId, text: "Old" },
	]);
	await Effect.runPromise(
		updateQueuedComposerMessage(scope, messageId, " Also the README "),
	);
	expect(mocks.update).toHaveBeenCalledWith(
		"owner",
		"chat",
		messageId,
		"Also the README",
		expect.stringContaining("Also the README"),
		false,
	);
});

it("marks Send for the next step while the turn runs, and starts it once the turn has ended", async () => {
	await Effect.runPromise(
		releaseQueuedComposerMessage(machines, scope, messageId),
	);
	expect(mocks.send).not.toHaveBeenCalled();
	mocks.release.mockResolvedValue({
		status: "taken",
		send: {
			item: { kind: "userMessage", id: messageId, text: "Then deploy" },
			message: "Then deploy",
			harnessId: "api",
			modelId: "connection|model",
			released: true,
		},
	});
	mocks.session.mockResolvedValue({
		id: "chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	});
	await Effect.runPromise(
		releaseQueuedComposerMessage(machines, scope, messageId),
	);
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ sessionId: "chat", createNew: false }),
		expect.objectContaining({
			text: "Then deploy",
			idempotencyKey: messageId,
		}),
		// The queue check reads only the chat's row; the send reads what it needs.
		undefined,
	);
});

describe("messages held while the project's environment is set up", () => {
	const failedWorkspace = {
		id: "workspace",
		status: "failed",
		providerRef: null,
		templateSnapshotId: null,
	};
	const newChatScope = {
		userId: "owner",
		projectId: "project",
		harnessId: "api" as const,
		createNew: true,
	};
	const heldChat = {
		id: "held-chat",
		projectId: "project",
		harness: "api",
		turnStatus: "idle",
		items: [],
	};

	it("stores a new chat's first send in a new, titled chat instead of starting a turn", async () => {
		mocks.workspace.mockResolvedValue(failedWorkspace);
		mocks.insert.mockResolvedValue(heldChat);
		mocks.read.mockReturnValue(
			Effect.succeed({ ...view("idle"), agentSessionId: "held-chat" }),
		);
		mocks.queued.mockResolvedValue([]);
		const result = await Effect.runPromise(
			sendComposerMessage(machines, newChatScope, {
				text: "Add a login page",
				modelId: "connection|model",
				idempotencyKey: messageId,
				baseBranch: "develop",
				environmentSetup: true,
			}),
		);
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.insert).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project",
				workspaceId: "workspace",
				title: "Add a login page",
			}),
		);
		const [owner, chat, held] = mocks.hold.mock.calls[0];
		expect([owner, chat]).toEqual(["owner", "held-chat"]);
		expect(held).toMatchObject({
			item: { kind: "userMessage", id: messageId, text: "Add a login page" },
			modelId: "connection|model",
			baseBranch: "develop",
			environmentSetup: true,
		});
		expect(result.agentSessionId).toBe("held-chat");
		// Not ready on the second look either: nothing goes yet.
		expect(mocks.releaseHeld).not.toHaveBeenCalled();
	});

	it("marks the chat holding a setup request as the project's setup chat at once", async () => {
		mocks.workspace.mockResolvedValue(failedWorkspace);
		mocks.insert.mockResolvedValue(heldChat);
		mocks.read.mockReturnValue(
			Effect.succeed({ ...view("idle"), agentSessionId: "held-chat" }),
		);
		await Effect.runPromise(
			sendComposerMessage(machines, newChatScope, {
				text: ENVIRONMENT_SETUP_PROMPT,
				modelId: "connection|model",
				idempotencyKey: messageId,
				environmentSetup: true,
			}),
		);
		expect(mocks.insert).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Set up project" }),
		);
		expect(mocks.markSetup).toHaveBeenCalledWith(
			"owner",
			"held-chat",
			"Set up project",
		);
		expect(mocks.hold).toHaveBeenCalledOnce();
	});

	it("starts a new project's setup once: a second start gets the chat that has it", async () => {
		const initial = initialSetupMessageId("project");
		mocks.workspace.mockResolvedValue(failedWorkspace);
		mocks.read.mockReturnValue(
			Effect.succeed({ ...view("idle"), agentSessionId: "setup-chat" }),
		);
		// Still held (another tab started it a moment ago)...
		mocks.holding.mockResolvedValue("setup-chat");
		const second = await Effect.runPromise(
			sendComposerMessage(
				machines,
				{ ...scope, sessionId: "fresh-chat" },
				{
					text: ENVIRONMENT_SETUP_PROMPT,
					modelId: "connection|model",
					idempotencyKey: initial,
					environmentSetup: true,
				},
			),
		);
		expect(second.agentSessionId).toBe("setup-chat");
		// ...or already sent, its chat marked as the project's setup chat.
		mocks.holding.mockResolvedValue(null);
		mocks.otherSetup.mockResolvedValue("setup-chat");
		await Effect.runPromise(
			sendComposerMessage(machines, newChatScope, {
				text: ENVIRONMENT_SETUP_PROMPT,
				modelId: "connection|model",
				idempotencyKey: initial,
				environmentSetup: true,
			}),
		);
		expect(mocks.otherSetup).toHaveBeenCalledWith("owner", "project", null);
		expect(mocks.hold).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it("delivers the new project's held setup request in its own chat", async () => {
		const initial = initialSetupMessageId("project");
		mocks.otherSetup.mockResolvedValue("older-setup-chat");
		mocks.releasable.mockResolvedValue([
			{ userId: "owner", sessionId: "held-chat", workspaceId: "workspace" },
		]);
		mocks.session.mockResolvedValue(heldChat);
		mocks.take.mockResolvedValueOnce({
			item: {
				kind: "userMessage",
				id: initial,
				text: ENVIRONMENT_SETUP_PROMPT,
			},
			message: ENVIRONMENT_SETUP_PROMPT,
			harnessId: "api",
			modelId: "connection|model",
			environmentSetup: true,
			released: true,
		});
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		expect(await deliverHeldSends(machines, "workspace")).toBe(1);
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
			sessionId: "held-chat",
		});
	});

	it("starts a new project's background setup in its own chat at once when the build is already ready", async () => {
		mocks.claimSetup.mockResolvedValue({
			session: { ...heldChat, id: "setup-chat", items: [] },
			created: true,
		});
		mocks.session.mockResolvedValue({ ...heldChat, id: "setup-chat" });
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		await Effect.runPromise(
			sendComposerMessage(machines, newChatScope, {
				text: ENVIRONMENT_SETUP_PROMPT,
				modelId: "connection|model",
				idempotencyKey: initialSetupMessageId("project"),
				environmentSetup: true,
			}),
		);
		expect(mocks.claimSetup).toHaveBeenCalledOnce();
		expect(mocks.hold).not.toHaveBeenCalled();
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({
			sessionId: "setup-chat",
			createNew: false,
		});
	});

	it("lets Rerun setup start another setup chat", async () => {
		mocks.otherSetup.mockResolvedValue("setup-chat");
		mocks.session.mockResolvedValue({ ...heldChat, id: "chat" });
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: ENVIRONMENT_SETUP_PROMPT,
				modelId: "connection|model",
				idempotencyKey: messageId,
				environmentSetup: true,
			}),
		);
		expect(mocks.otherSetup).not.toHaveBeenCalled();
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it("holds a replayed send once, in the chat it already landed in", async () => {
		mocks.workspace.mockResolvedValue(failedWorkspace);
		mocks.holding.mockResolvedValue("held-chat");
		mocks.session.mockResolvedValue(heldChat);
		mocks.queued.mockResolvedValue([
			{ kind: "userMessage", id: messageId, text: "Add a login page" },
		]);
		await Effect.runPromise(
			sendComposerMessage(machines, newChatScope, {
				text: "Add a login page",
				modelId: "connection|model",
				idempotencyKey: messageId,
				environmentSetup: true,
			}),
		);
		expect(mocks.insert).not.toHaveBeenCalled();
		expect(mocks.reusable).not.toHaveBeenCalled();
		expect(mocks.hold).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	const buildingWorkspace = {
		id: "workspace",
		status: "cloning",
		providerRef: null,
		templateSnapshotId: null,
	};

	it("never holds a task during the first build: it starts at once, and the project's setup starts beside it", async () => {
		mocks.workspace.mockResolvedValue(buildingWorkspace);
		mocks.session.mockImplementation(async (_owner: string, id: string) => ({
			...heldChat,
			id,
		}));
		mocks.claimSetup.mockResolvedValue({
			session: { ...heldChat, id: "setup-chat", items: [] },
			created: true,
		});
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "Add a login page",
				modelId: "connection|model",
				variant: "high",
				idempotencyKey: messageId,
			}),
		);
		// The task's own turn starts now, in its own chat.
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({ sessionId: "chat" });
		// The setup chat is claimed once per project and its request waits there
		// for the build, on the task's model.
		expect(mocks.claimSetup).toHaveBeenCalledOnce();
		expect(mocks.hold).toHaveBeenCalledOnce();
		const [owner, chat, held] = mocks.hold.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		];
		expect([owner, chat]).toEqual(["owner", "setup-chat"]);
		expect(held).toMatchObject({
			item: {
				id: initialSetupMessageId("project"),
				text: ENVIRONMENT_SETUP_PROMPT,
			},
			modelId: "connection|model",
			variant: "high",
			environmentSetup: true,
		});
		expect(mocks.markSetup).toHaveBeenCalledWith(
			"owner",
			"setup-chat",
			"Set up project",
		);
	});

	it("starts no second setup beside a task when the project has its setup chat", async () => {
		mocks.workspace.mockResolvedValue(buildingWorkspace);
		mocks.session.mockResolvedValue({ ...heldChat, id: "chat" });
		mocks.otherSetup.mockResolvedValue("setup-chat");
		mocks.read.mockReturnValue(Effect.succeed(view("idle")));
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "Add a login page",
				modelId: "connection|model",
			}),
		);
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(mocks.claimSetup).not.toHaveBeenCalled();
		expect(mocks.hold).not.toHaveBeenCalled();
	});

	it("never holds a task after a failed build either, and starts no setup beside it", async () => {
		mocks.workspace.mockResolvedValue(failedWorkspace);
		mocks.session.mockResolvedValue({ ...heldChat, id: "chat" });
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "Add a login page",
				modelId: "connection|model",
			}),
		);
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(mocks.hold).not.toHaveBeenCalled();
		expect(mocks.claimSetup).not.toHaveBeenCalled();
	});

	it("still sends the task when its setup chat cannot be started", async () => {
		mocks.workspace.mockResolvedValue(buildingWorkspace);
		mocks.session.mockResolvedValue({ ...heldChat, id: "chat" });
		mocks.claimSetup.mockRejectedValue(new Error("database is busy"));
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "Add a login page",
				modelId: "connection|model",
			}),
		);
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("sends at once when the environment became ready while the message was stored", async () => {
		mocks.workspace
			.mockResolvedValueOnce(failedWorkspace)
			.mockResolvedValue(readyWorkspace);
		mocks.insert.mockResolvedValue(heldChat);
		mocks.session.mockResolvedValue(heldChat);
		mocks.take.mockResolvedValue({
			item: { kind: "userMessage", id: messageId, text: "Add a login page" },
			message: "Add a login page",
			harnessId: "api",
			modelId: "connection|model",
			released: true,
		});
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		await Effect.runPromise(
			sendComposerMessage(machines, newChatScope, {
				text: "Add a login page",
				modelId: "connection|model",
				idempotencyKey: messageId,
				environmentSetup: true,
			}),
		);
		expect(mocks.releaseHeld).toHaveBeenCalledWith("held-chat");
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it("never holds runtime sends or plan approvals", async () => {
		mocks.workspace.mockResolvedValue(failedWorkspace);
		mocks.session.mockResolvedValue({ ...heldChat, id: "chat" });
		await Effect.runPromise(
			sendComposerMessage(machines, scope, {
				text: "Approved",
				modelId: "connection|model",
				approvesPlan: true,
			}),
		);
		expect(mocks.hold).not.toHaveBeenCalled();
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it("delivers a held message exactly once when the environment is ready", async () => {
		mocks.releasable.mockResolvedValue([
			{ userId: "owner", sessionId: "held-chat", workspaceId: "workspace" },
		]);
		mocks.session.mockResolvedValue(heldChat);
		mocks.take.mockResolvedValueOnce({
			item: { kind: "userMessage", id: messageId, text: "Add a login page" },
			message: "Add a login page",
			harnessId: "api",
			modelId: "connection|model",
			baseBranch: "develop",
			environmentSetup: true,
			released: true,
		});
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		expect(await deliverHeldSends(machines, "workspace")).toBe(1);
		expect(mocks.releasable).toHaveBeenCalledWith("workspace");
		expect(mocks.send).toHaveBeenCalledOnce();
		const [, sent, task] = mocks.send.mock.calls[0];
		expect(sent).toMatchObject({ sessionId: "held-chat", createNew: false });
		expect(task).toMatchObject({
			text: "Add a login page",
			idempotencyKey: messageId,
			baseBranch: "develop",
			environmentSetup: true,
		});

		// The job and the sweep both ran: the second finds nothing held.
		mocks.releaseHeld.mockResolvedValue(false);
		expect(await deliverHeldSends(machines, "workspace")).toBe(0);
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it("holds and delivers on the model and route chosen at send, never the chat's listed one", async () => {
		const listedHaiku = {
			...heldChat,
			listedModelId: "claude-code/claude-haiku-5-5",
		};
		// Still being set up at the send and on its second look; ready after.
		mocks.workspace
			.mockResolvedValueOnce(failedWorkspace)
			.mockResolvedValueOnce(failedWorkspace)
			.mockResolvedValue(readyWorkspace);
		mocks.session.mockResolvedValue(listedHaiku);
		mocks.queued.mockResolvedValue([]);
		mocks.read.mockReturnValue(
			Effect.succeed({ ...view("idle"), agentSessionId: "held-chat" }),
		);
		await Effect.runPromise(
			sendComposerMessage(
				machines,
				{ ...scope, sessionId: "held-chat" },
				{
					text: "Reply with just the word HELD.",
					modelId: "claude-code/claude-opus-5-5",
					variant: "high",
					idempotencyKey: messageId,
					environmentSetup: true,
				},
			),
		);
		const [, , held] = mocks.hold.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		];
		expect(held).toMatchObject({
			harnessId: "api",
			modelId: "claude-code/claude-opus-5-5",
			variant: "high",
		});

		mocks.releasable.mockResolvedValue([
			{ userId: "owner", sessionId: "held-chat", workspaceId: "workspace" },
		]);
		mocks.take.mockResolvedValueOnce({ ...held, released: true });
		mocks.send.mockReturnValue(Effect.succeed(view("running")));
		expect(await deliverHeldSends(machines, "workspace")).toBe(1);
		const [, sent, task] = mocks.send.mock.calls[0];
		expect(sent).toMatchObject({ harnessId: "api", sessionId: "held-chat" });
		expect(task).toMatchObject({
			modelId: "claude-code/claude-opus-5-5",
			variant: "high",
			idempotencyKey: messageId,
		});
	});

	it("keeps a held message in the chat when its turn cannot start", async () => {
		mocks.releasable.mockResolvedValue([
			{ userId: "owner", sessionId: "held-chat", workspaceId: "workspace" },
		]);
		mocks.session.mockResolvedValue(heldChat);
		const next = {
			item: { kind: "userMessage", id: messageId, text: "Add a login page" },
			message: "Add a login page",
			harnessId: "api",
			modelId: "connection|model",
			released: true,
		};
		mocks.take.mockResolvedValueOnce(next);
		mocks.send.mockReturnValue(
			Effect.succeed({
				...view("idle"),
				connection: { status: "failed", message: "No model" },
			}),
		);
		expect(await deliverHeldSends(machines)).toBe(0);
		expect(mocks.restore).toHaveBeenCalledWith(
			"held-chat",
			expect.objectContaining({ item: next.item }),
		);
	});

	it("the sweep dispatches one job per workspace with a releasable message", async () => {
		mocks.releasable.mockResolvedValue([
			{ userId: "a", sessionId: "1", workspaceId: "w1" },
			{ userId: "a", sessionId: "2", workspaceId: "w1" },
			{ userId: "b", sessionId: "3", workspaceId: "w2" },
		]);
		await dispatchReleasableHeldSends(120_000);
		expect(mocks.dispatch.mock.calls.map(([job]) => job)).toEqual([
			{
				id: "job:held-sends:sweep:w1:2",
				kind: "held-sends",
				workspaceId: "w1",
			},
			{
				id: "job:held-sends:sweep:w2:2",
				kind: "held-sends",
				workspaceId: "w2",
			},
		]);
	});
});
