import { expect, it, vi } from "vitest";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { ConversationRoom, routeRealtimeRequest } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const userId = "alice";
const sessionId = "00000000-0000-4000-8000-000000000007";
const secret = "test-only-realtime-secret-0123456789abcdef";

const snapshot = (revision: string, text: string, owner = userId) => ({
	userId: owner,
	sessionId,
	revision,
	progress: {
		sessionId,
		turnStatus: "running",
		items: [{ kind: "agentMessage", id: "a", text }],
	},
});
const streamUrl = `https://room/stream?${new URLSearchParams({ userId, sessionId })}`;

async function firstEvent(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	const event = new TextDecoder().decode((await reader.read()).value);
	await reader.cancel();
	return event;
}

it("seeds an empty room from the subscription's own snapshot and streams it", async () => {
	const room = new ConversationRoom(durableObjectState().ctx as never);
	// The old way: a miss.
	expect((await room.fetch(new Request(streamUrl))).status).toBe(404);
	const response = await room.fetch(
		new Request(streamUrl, {
			method: "POST",
			body: JSON.stringify(snapshot("3", "from postgres")),
		}),
	);
	expect(response.status).toBe(200);
	expect(await firstEvent(response)).toContain('"text":"from postgres"');
	// Kept for the next subscriber.
	expect(await firstEvent(await room.fetch(new Request(streamUrl)))).toContain(
		'"text":"from postgres"',
	);
});

it("never regresses a room to an older subscription snapshot, nor accepts another chat's", async () => {
	const room = new ConversationRoom(durableObjectState().ctx as never);
	await room.fetch(
		new Request("https://room/snapshot", {
			method: "POST",
			body: JSON.stringify(snapshot("9", "newer")),
		}),
	);
	const stale = await room.fetch(
		new Request(streamUrl, {
			method: "POST",
			body: JSON.stringify(snapshot("4", "stale")),
		}),
	);
	expect(await firstEvent(stale)).toContain('"text":"newer"');
	// The body must be the chat the subscription names.
	const mismatched = await room.fetch(
		new Request(streamUrl, {
			method: "POST",
			body: JSON.stringify(snapshot("10", "other", "mallory")),
		}),
	);
	expect(mismatched.status).toBe(400);
});

it("routes only a signed subscription with a snapshot", async () => {
	const forward = vi.fn(async () => new Response(null, { status: 200 }));
	const url = `https://edge.test/stream?${new URLSearchParams({ userId, sessionId })}`;
	const body = JSON.stringify(snapshot("1", "x"));
	const signed = new Request(url, {
		method: "POST",
		headers: await signDeliveryRequest(secret, "POST", url, body),
		body,
	});
	expect((await routeRealtimeRequest(signed, secret, forward)).status).toBe(
		200,
	);
	expect(forward).toHaveBeenCalledWith(
		{ userId, sessionId },
		expect.any(Request),
	);
	const unsigned = new Request(url, { method: "POST", body });
	expect((await routeRealtimeRequest(unsigned, secret, forward)).status).toBe(
		401,
	);
	expect(forward).toHaveBeenCalledOnce();
});
