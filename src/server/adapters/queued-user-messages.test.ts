import { beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { MID_TURN_USER_NOTE } from "#/domain/peer-inbox-injection";
import {
	queueUserMessageWhileRunning,
	releaseQueuedUserMessage,
	removeQueuedUserMessage,
	takeNextQueuedUserMessage,
	updateQueuedUserMessage,
} from "./queued-user-messages";
import { injectServerPeerMessages } from "./server-peer-inbox";

const mocks = vi.hoisted(() => ({ query: vi.fn(), wake: vi.fn() }));
vi.mock("./database", () => ({ database: () => ({ query: mocks.query }) }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: mocks.wake,
}));

beforeEach(() => {
	mocks.query.mockReset();
	mocks.wake.mockReset();
});

const send = {
	item: {
		kind: "userMessage" as const,
		id: SessionItemId("11111111-1111-4111-8111-111111111111"),
		text: "Also the README",
	},
	message: "Also the README",
	harnessId: "api" as const,
	modelId: "connection|model",
};

it("queues only under the running session's row lock and republishes the chat", async () => {
	mocks.query.mockResolvedValueOnce({ rows: [{ running: 1 }] });
	expect(await queueUserMessageWhileRunning("owner", "chat", send)).toBe(
		"queued",
	);
	const [sql, parameters] = mocks.query.mock.calls[0];
	expect(sql).toContain(
		"update agent_session set items=items where id=$1 and user_id=$2 and turn_status='running'",
	);
	expect(sql).toContain("on conflict(id) do update");
	expect(parameters.slice(0, 4)).toEqual([
		"chat",
		"owner",
		"queued-user:11111111-1111-4111-8111-111111111111",
		"Also the README",
	]);
	expect(JSON.parse(parameters[4])).not.toHaveProperty("message");
	expect(mocks.wake).toHaveBeenCalledOnce();

	mocks.query.mockResolvedValueOnce({ rows: [{ running: 0 }] });
	expect(await queueUserMessageWhileRunning("owner", "chat", send)).toBe(
		"not-running",
	);
});

it("takes a waiting message only once no turn runs, and removes only undelivered ones", async () => {
	mocks.query.mockResolvedValueOnce({
		rows: [
			{
				message: "Also the README",
				queued_send: { ...send, message: undefined },
			},
		],
	});
	expect(await takeNextQueuedUserMessage("owner", "chat")).toMatchObject({
		message: "Also the README",
		item: { id: send.item.id },
	});
	expect(mocks.query.mock.calls[0][0]).toContain("s.turn_status<>'running'");
	expect(mocks.query.mock.calls[0][0]).toContain("skip locked");

	mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
	expect(await removeQueuedUserMessage("owner", "chat", send.item.id)).toBe(
		false,
	);
	expect(mocks.query.mock.calls[1][0]).toContain("not q.accepted");
});

it("delivers queued user messages by id, even when their words repeat earlier ones", async () => {
	mocks.query.mockResolvedValueOnce({
		rows: [
			{ id: "notice", message: "Child finished", queued_send: null },
			{
				id: "queued-user:a",
				message: "yes",
				queued_send: { item: { ...send.item, id: "a", text: "yes" } },
			},
			{
				id: "queued-user:b",
				message: "yes",
				queued_send: { item: { ...send.item, id: "b", text: "yes" } },
			},
		],
	});
	mocks.query.mockResolvedValueOnce({ rows: [] });
	const checkpoint = vi.fn(async () => {});
	const history = await injectServerPeerMessages(
		"chat",
		[
			{ role: "user", content: "yes" },
			{ role: "user", content: "Child finished" },
		],
		checkpoint,
		(id) => id === "b",
	);
	// The notice was already in the history; "b" was already in the transcript.
	expect(history.slice(2)).toEqual([
		{ role: "user", content: `${MID_TURN_USER_NOTE}\n\nyes` },
	]);
	expect(checkpoint).toHaveBeenCalledWith(history, [
		expect.objectContaining({ id: "a" }),
	]);
	expect(mocks.query.mock.calls[1][1]).toEqual([
		"chat",
		["notice", "queued-user:a", "queued-user:b"],
	]);
});

it("keeps an unreleased queued message out of the next step", async () => {
	mocks.query.mockResolvedValueOnce({
		rows: [
			{
				id: "queued-user:a",
				message: "later",
				queued_send: {
					item: { ...send.item, id: "a", text: "later" },
					released: false,
				},
			},
		],
	});
	const checkpoint = vi.fn(async () => {});
	const history = await injectServerPeerMessages("chat", [], checkpoint);
	expect(history).toEqual([]);
	expect(checkpoint).not.toHaveBeenCalled();
	expect(mocks.query).toHaveBeenCalledOnce();
});

it("edits a waiting message and marks Send without taking it while the turn runs", async () => {
	mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "chat" }] });
	expect(
		await updateQueuedUserMessage(
			"owner",
			"chat",
			send.item.id,
			"Next",
			"Next",
		),
	).toBe(true);
	expect(mocks.query.mock.calls[0][0]).toContain(
		"jsonb_set(q.queued_send, '{item,text}'",
	);
	expect(mocks.query.mock.calls[0][0]).toContain("not q.accepted");

	mocks.query.mockResolvedValueOnce({
		rows: [{ turn_status: "running", message: null, queued_send: null }],
	});
	expect(await releaseQueuedUserMessage("owner", "chat", send.item.id)).toEqual(
		{ status: "running" },
	);
	expect(mocks.query.mock.calls[1][0]).toContain("turn_status='running'");
	expect(mocks.query.mock.calls[1][0]).toContain("turn_status<>'running'");
	expect(mocks.wake).toHaveBeenCalled();
});
