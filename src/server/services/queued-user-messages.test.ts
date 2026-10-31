import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	queue: vi.fn(),
	queued: vi.fn(async () => [] as unknown[]),
	take: vi.fn(),
	restore: vi.fn(async () => {}),
	remove: vi.fn(async () => true),
	update: vi.fn(async () => true),
	release: vi.fn(async () => ({ status: "running" as const })),
	send: vi.fn(),
	read: vi.fn(),
	stop: vi.fn(),
	store: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
	agentSessionPageForOwner: vi.fn(async () => null),
}));
vi.mock("../adapters/queued-user-messages", () => ({
	queueUserMessageWhileRunning: mocks.queue,
	queuedUserMessageItems: mocks.queued,
	takeNextQueuedUserMessage: mocks.take,
	restoreQueuedUserMessage: mocks.restore,
	removeQueuedUserMessage: mocks.remove,
	updateQueuedUserMessage: mocks.update,
	releaseQueuedUserMessage: mocks.release,
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
		// The idle chat as the queue check read it, so the send skips that read.
		expect.objectContaining({ id: "chat", turnStatus: "idle" }),
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

it("keeps queued messages through Stop and starts them once nothing runs", async () => {
	mocks.stop.mockReturnValue(Effect.succeed(view("running")));
	await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
	expect(mocks.take).not.toHaveBeenCalled();
	mocks.stop.mockReturnValue(Effect.succeed(view("idle")));
	mocks.take.mockResolvedValue(null);
	await Effect.runPromise(stopTurnKeepingQueue(machines, scope));
	expect(mocks.take).toHaveBeenCalledWith("owner", "chat");
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
		expect.objectContaining({ id: "chat", turnStatus: "idle" }),
	);
});
