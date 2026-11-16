import { expect, it } from "vitest";
import { TURN_COORDINATION_LEASE_MS } from "../src/domain/conversation-turn-control";
import { ConversationRoom } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const turn = { turnId: "t1", leaseId: "l1" };

async function room(active: { expiresAt: number; cancelled: boolean }) {
	const state = durableObjectState();
	const schedules: (number | null)[] = [];
	const conversation = new ConversationRoom(
		state.ctx as never,
		async (at: number | null) => {
			schedules.push(at);
		},
	);
	await state.ctx.storage.put("identity", { userId: "u", sessionId: "s" });
	await state.ctx.storage.put("active-turn", {
		userId: "u",
		sessionId: "s",
		...turn,
		...active,
	});
	return { conversation, storage: state.ctx.storage, schedules };
}

it("holds a parked turn's lease past the spacing, and its own alarm with it", async () => {
	const { conversation, storage, schedules } = await room({
		expiresAt: Date.now() + TURN_COORDINATION_LEASE_MS,
		cancelled: false,
	});
	expect(await conversation.renewParked(turn, 120_000)).toBe(true);
	const held = await storage.get<{ expiresAt: number }>("active-turn");
	expect(held?.expiresAt).toBeGreaterThan(Date.now() + 110_000);
	expect(schedules.at(-1)).toBe(held?.expiresAt);
	expect(await conversation.heldTurn(turn)).toMatchObject({
		...turn,
		cancelled: false,
	});
	// A renewal never shortens the lease.
	expect(await conversation.renewParked(turn, 1_000)).toBe(true);
	expect(
		(await storage.get<{ expiresAt: number }>("active-turn"))?.expiresAt,
	).toBe(held?.expiresAt);
});

it("refuses a cancelled, lapsed or replaced turn, which then steps", async () => {
	const cancelled = await room({
		expiresAt: Date.now() + 30_000,
		cancelled: true,
	});
	expect(await cancelled.conversation.renewParked(turn, 120_000)).toBe(false);
	expect(await cancelled.conversation.heldTurn(turn)).toMatchObject({
		cancelled: true,
	});
	const lapsed = await room({ expiresAt: Date.now() - 1, cancelled: false });
	expect(await lapsed.conversation.renewParked(turn, 120_000)).toBe(false);
	const other = await room({
		expiresAt: Date.now() + 30_000,
		cancelled: false,
	});
	expect(
		await other.conversation.renewParked({ ...turn, leaseId: "l2" }, 120_000),
	).toBe(false);
	expect(
		await other.conversation.heldTurn({ ...turn, leaseId: "l2" }),
	).toBeNull();
});
