import { expect, it, vi } from "vitest";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { ConversationRoom, routeRealtimeRequest } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const secret = "test-only-realtime-secret-0123456789abcdef";
const sessionId = "00000000-0000-4000-8000-000000000003";

async function signed(path: string, body: string) {
	const url = `https://edge.test${path}`;
	return new Request(url, {
		method: "POST",
		headers: await signDeliveryRequest(secret, "POST", url, body),
		body,
	});
}

it("routes a signed purge to the chat's object by owner and chat, and nothing unsigned", async () => {
	const forward = vi.fn(async () => new Response(null, { status: 204 }));
	const body = JSON.stringify({ userId: "alice", sessionId });
	expect(
		(await routeRealtimeRequest(await signed("/purge", body), secret, forward))
			.status,
	).toBe(204);
	expect(forward).toHaveBeenCalledWith(
		{ userId: "alice", sessionId },
		expect.any(Request),
	);
	const unsigned = new Request("https://edge.test/purge", {
		method: "POST",
		body,
	});
	expect((await routeRealtimeRequest(unsigned, secret, forward)).status).toBe(
		401,
	);
	expect(forward).toHaveBeenCalledTimes(1);
});

it("deletes the room's stored snapshot, turn state and alarm", async () => {
	const state = durableObjectState();
	const room = new ConversationRoom(state.ctx as never);
	await state.ctx.storage.put("head", { revision: "1", chunks: 0 });
	await state.ctx.storage.put("active-turn", { turnId: "t" });
	await state.ctx.storage.setAlarm(Date.now() + 1000);
	const response = await room.fetch(
		new Request("https://edge.test/purge", { method: "POST" }),
	);
	expect(response.status).toBe(204);
	expect(await state.ctx.storage.get("head")).toBeUndefined();
	expect(await state.ctx.storage.get("active-turn")).toBeUndefined();
	expect(state.alarm.at).toBeNull();
});

it("keeps a tombstone that refuses every later write, in this object and after a restart", async () => {
	const state = durableObjectState();
	const room = new ConversationRoom(state.ctx as never);
	const snapshot = (revision: string) =>
		new Request("https://edge.test/snapshot", {
			method: "POST",
			body: JSON.stringify({
				userId: "alice",
				sessionId,
				revision,
				progress: { sessionId, turnStatus: "running", items: [] },
			}),
		});
	const turn = (action: string) =>
		new Request(`https://edge.test/turn/${action}`, {
			method: "POST",
			body: JSON.stringify({
				userId: "alice",
				sessionId,
				turnId: "00000000-0000-4000-8000-000000000010",
				leaseId: "00000000-0000-4000-8000-000000000011",
			}),
		});
	expect((await room.fetch(snapshot("1"))).status).toBe(204);
	expect((await room.fetch(turn("acquire"))).status).toBe(204);
	await room.fetch(new Request("https://edge.test/purge", { method: "POST" }));
	// The in-flight turn renews, publishes progress and its alarm fires: all refused.
	expect((await room.fetch(snapshot("2"))).status).toBe(410);
	expect((await room.fetch(turn("renew"))).status).toBe(410);
	expect((await room.fetch(turn("acquire"))).status).toBe(410);
	expect(
		await room.reclaim({
			turnId: "00000000-0000-4000-8000-000000000010",
			leaseId: "00000000-0000-4000-8000-000000000012",
		}),
	).toBe(false);
	await room.alarm();
	expect(await state.ctx.storage.get("head")).toBeUndefined();
	expect(await state.ctx.storage.get("active-turn")).toBeUndefined();
	expect(await state.ctx.storage.get("identity")).toBeUndefined();
	expect(state.alarm.at).toBeNull();
	// A restarted object reads the tombstone and still refuses.
	const restarted = new ConversationRoom(state.ctx as never);
	await Promise.resolve();
	expect((await restarted.fetch(snapshot("3"))).status).toBe(410);
	expect(await state.ctx.storage.get("head")).toBeUndefined();
	// Purging again is fine.
	expect(
		(
			await restarted.fetch(
				new Request("https://edge.test/purge", { method: "POST" }),
			)
		).status,
	).toBe(204);
});
