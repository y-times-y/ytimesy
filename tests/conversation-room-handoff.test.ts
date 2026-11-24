import { describe, expect, it } from "vitest";
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
	extra: Record<string, string> = {},
) {
	return conversation.fetch(
		new Request(`https://chat.internal/turn/${action}`, {
			method: "POST",
			body: JSON.stringify({
				userId: "u",
				sessionId,
				turnId,
				leaseId,
				...extra,
			}),
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

it("still refuses the box's old lease after a hand-off", async () => {
	const conversation = room();
	await control(conversation, "acquire", boxLease);
	await control(conversation, "handoff", boxLease);
	await control(conversation, "acquire", objectLease);
	expect((await control(conversation, "renew", boxLease)).status).toBe(409);
	expect((await control(conversation, "acquire", boxLease)).status).toBe(409);
});

it("refuses a hand-off from a lease that does not hold the turn", async () => {
	const conversation = room();
	await control(conversation, "acquire", boxLease);
	expect((await control(conversation, "handoff", objectLease)).status).toBe(
		409,
	);
	expect((await control(conversation, "renew", boxLease)).status).toBe(204);
});

function roomWithState() {
	const state = durableObjectState();
	return {
		conversation: new ConversationRoom(state.ctx as never, async () => {}),
		storage: state.ctx.storage,
	};
}

// A box died: the room's lease lapsed and its alarm retired it; Postgres
// requeued the turn after 45 s and another box claimed it under a new lease.
// Retiring the turn ID refused that box until 70 s after the lapse.
it("lets a new owner take a turn whose earlier lease lapsed, and keeps the lapsed lease out", async () => {
	const { conversation, storage } = roomWithState();
	expect((await control(conversation, "acquire", boxLease)).status).toBe(204);
	const held = await storage.get<{ expiresAt: number }>("active-turn");
	await storage.put("active-turn", { ...held, expiresAt: Date.now() - 1 });
	await conversation.alarm();
	expect((await control(conversation, "acquire", boxLease)).status).toBe(409);
	expect((await control(conversation, "acquire", objectLease)).status).toBe(
		204,
	);
});

it("lets a new owner take a turn another lease finished (released)", async () => {
	const { conversation } = roomWithState();
	await control(conversation, "acquire", boxLease);
	await control(conversation, "release", boxLease);
	expect((await control(conversation, "acquire", boxLease)).status).toBe(409);
	expect((await control(conversation, "acquire", objectLease)).status).toBe(
		204,
	);
});

it("still honours a retirement written by the earlier code (turn ID only) until it expires", async () => {
	const { conversation, storage } = roomWithState();
	await storage.put("identity", { userId: "u", sessionId });
	await storage.put("retired-turns", { [turnId]: Date.now() + 60_000 });
	expect((await control(conversation, "acquire", objectLease)).status).toBe(
		409,
	);
	await storage.put("retired-turns", { [turnId]: Date.now() - 1 });
	expect((await control(conversation, "acquire", objectLease)).status).toBe(
		204,
	);
});

// A running turn's renewals came late (a box's port call hung) and the
// room's lease lapsed; the turn still owns its lease in Postgres
// ("Run stopped. Conversation coordination lease was lost", 2026-11-23).
it("lets a running turn take back its lapsed lease, but never from a live holder or after a Stop", async () => {
	const { conversation, storage } = roomWithState();
	await control(conversation, "acquire", boxLease);
	const held = await storage.get<{ expiresAt: number }>("active-turn");
	await storage.put("active-turn", { ...held, expiresAt: Date.now() - 1 });
	await conversation.alarm();
	expect((await control(conversation, "renew", boxLease)).status).toBe(409);
	expect((await control(conversation, "resume", boxLease)).status).toBe(204);
	expect((await control(conversation, "renew", boxLease)).status).toBe(204);
	// Another owner holds it: no resume.
	await control(conversation, "handoff", boxLease);
	await control(conversation, "acquire", objectLease);
	expect((await control(conversation, "resume", boxLease)).status).toBe(409);
	// Stopped: no resume.
	await control(conversation, "cancel", objectLease);
	expect((await control(conversation, "resume", objectLease)).status).toBe(409);
});

// 2026-11-24: a turn ran 14 minutes, then a step could not take the chat's
// lock back and the turn ended with "This turn did not start". The database
// allows one active turn per chat, so a holder the room still names is stale.
describe("a turn taking over the chat's lock", () => {
	const otherTurn = { turnId: "00000000-0000-4000-8000-0000000000c1" };

	it("takes it from a stale turn whose lease the room still holds, and the stale one is refused from then on", async () => {
		const conversation = room();
		expect(
			(await control(conversation, "acquire", boxLease, otherTurn)).status,
		).toBe(204);
		// New turn: refused by acquire while the old lease is live, takes over.
		expect((await control(conversation, "acquire", objectLease)).status).toBe(
			409,
		);
		expect((await control(conversation, "takeover", objectLease)).status).toBe(
			204,
		);
		expect((await control(conversation, "renew", objectLease)).status).toBe(
			204,
		);
		expect(
			(await control(conversation, "renew", boxLease, otherTurn)).status,
		).toBe(409);
	});

	it("takes back its own lapsed or retired lease", async () => {
		const conversation = room();
		await control(conversation, "acquire", boxLease);
		await control(conversation, "release", boxLease);
		expect((await control(conversation, "acquire", boxLease)).status).toBe(409);
		expect((await control(conversation, "takeover", boxLease)).status).toBe(
			204,
		);
	});

	it("never takes it from a live code restore, and does once the restore's lease has lapsed", async () => {
		const { conversation, storage } = roomWithState();
		await control(conversation, "acquire", boxLease, {
			...otherTurn,
			hold: "restore",
		});
		expect((await control(conversation, "takeover", objectLease)).status).toBe(
			409,
		);
		const held = await storage.get<{ expiresAt: number }>("active-turn");
		await storage.put("active-turn", { ...held, expiresAt: Date.now() - 1 });
		expect((await control(conversation, "takeover", objectLease)).status).toBe(
			204,
		);
	});

	it("never takes it for a turn that was stopped", async () => {
		const conversation = room();
		await control(conversation, "acquire", boxLease);
		await control(conversation, "cancel", boxLease);
		expect((await control(conversation, "takeover", objectLease)).status).toBe(
			409,
		);
	});
});
