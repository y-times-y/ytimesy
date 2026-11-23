import { expect, it } from "vitest";
import { ConversationRoom } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const sessionId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-0000000000a1";
const boxLease = "00000000-0000-4000-8000-0000000000b1";
const objectLease = "00000000-0000-4000-8000-0000000000b2";

function room() {
	const state = durableObjectState();
	return new ConversationRoom(state.ctx as never, async () => {});
}

function control(
	conversation: ConversationRoom,
	action: string,
	leaseId: string,
) {
	return conversation.fetch(
		new Request(`https://chat.internal/turn/${action}`, {
			method: "POST",
			body: JSON.stringify({ userId: "u", sessionId, turnId, leaseId }),
		}),
	);
}

// Production 2026-11-23 (chat 3b8ac257): a box handed a turn to the chat's
// object; the hand-off released the box's lease, which retired the turn for
// 70 s, and the object's acquire of the same turn (new lease) was refused
// until it gave up after 35 s: "could not confirm this turn's ownership".
it("lets the chat's object acquire a turn a box handed over, under its new lease", async () => {
	const conversation = room();
	expect((await control(conversation, "acquire", boxLease)).status).toBe(204);
	expect((await control(conversation, "handoff", boxLease)).status).toBe(204);
	expect((await control(conversation, "acquire", objectLease)).status).toBe(
		204,
	);
	expect((await control(conversation, "renew", objectLease)).status).toBe(204);
});

it("still refuses the box's old lease after a hand-off, and a lapsed release stays retired", async () => {
	const conversation = room();
	await control(conversation, "acquire", boxLease);
	await control(conversation, "handoff", boxLease);
	await control(conversation, "acquire", objectLease);
	expect((await control(conversation, "renew", boxLease)).status).toBe(409);
	const other = room();
	await control(other, "acquire", boxLease);
	await control(other, "release", boxLease);
	expect((await control(other, "acquire", objectLease)).status).toBe(409);
});

it("refuses a hand-off from a lease that does not hold the turn", async () => {
	const conversation = room();
	await control(conversation, "acquire", boxLease);
	expect((await control(conversation, "handoff", objectLease)).status).toBe(
		409,
	);
	expect((await control(conversation, "renew", boxLease)).status).toBe(204);
});
