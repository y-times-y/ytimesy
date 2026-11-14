import { afterEach, expect, it, vi } from "vitest";
import type { ServerSocket } from "../src/realtime/socket-upgrade";
import { ConversationRoom } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const sessionId = "00000000-0000-4000-8000-000000000099";
const full = {
	userId: "river",
	sessionId,
	revision: "1",
	progress: {
		sessionId,
		items: [{ id: "one", kind: "agentMessage", text: "hello" }],
		turnStatus: "running" as const,
	},
	window: { itemsRev: "7", first: 0, end: 1, hidden: [] },
};
function fixture() {
	const state = durableObjectState();
	const viewers: ServerSocket[] = [];
	let attachment: unknown;
	const socket = {
		send: vi.fn(),
		close: vi.fn(),
		accept: vi.fn(),
		serializeAttachment(value: unknown) {
			attachment = value;
		},
		deserializeAttachment() {
			return attachment;
		},
	};
	const autoResponse = vi.fn();
	const room = new ConversationRoom(
		{
			...state.ctx,
			acceptWebSocket(s: ServerSocket) {
				viewers.push(s);
			},
			getWebSockets() {
				return viewers;
			},
			setWebSocketAutoResponse: autoResponse,
		} as never,
		undefined,
		{
			pair: () => ({ client: {}, server: socket }),
			upgrade: () => new Response(null, { status: 200 }),
			autoResponse: () => ({ request: "ping", response: "pong" }),
		},
	);
	const open = (userId = "river") =>
		room.fetch(
			new Request(`https://room/live?userId=${userId}&sessionId=${sessionId}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
	return { room, socket, autoResponse, open, state };
}
afterEach(() => vi.useRealTimers());
it("accepts hibernatable viewers, installs runtime ping responses, and sends deltas", async () => {
	const { room, socket, autoResponse, open } = fixture();
	await room.publish(full);
	expect((await open()).status).toBe(200);
	expect(autoResponse).toHaveBeenCalledWith({
		request: "ping",
		response: "pong",
	});
	expect(
		JSON.parse(socket.send.mock.calls[0][0]).progress.window.itemsRev,
	).toBe("7");
	const delta = {
		kind: "delta" as const,
		userId: "river",
		sessionId,
		revision: "2",
		baseItemsRev: "7",
		window: { itemsRev: "8", first: 0, end: 2 },
		rows: [
			{ position: 1, item: { id: "two", kind: "agentMessage", text: "world" } },
		],
		queued: [],
		hasOlderItems: false,
		turnStatus: "running" as const,
	};
	await room.publish(delta);
	expect(JSON.parse(socket.send.mock.calls[1][0]).delta.rows).toEqual(
		delta.rows,
	);
	expect(socket.deserializeAttachment()).toMatchObject({ revision: "2" });
});
it("checks ownership and closes expired authorization before sending more data", async () => {
	vi.useFakeTimers();
	const { room, socket, open } = fixture();
	await room.publish(full);
	expect((await open("other-owner")).status).toBe(404);
	await open();
	vi.advanceTimersByTime(60_001);
	await room.publish({ ...full, revision: "2" });
	expect(socket.send).toHaveBeenCalledTimes(1);
	expect(socket.close).toHaveBeenCalledWith(4002, "reauthorize");
});
it("restores viewer attachments after hibernation and closes viewers on purge", async () => {
	const { room, socket, open } = fixture();
	await room.publish(full);
	await open();
	await room.purge();
	expect(socket.close).toHaveBeenCalledWith(4410, "deleted");
	expect((await open()).status).toBe(410);
});
