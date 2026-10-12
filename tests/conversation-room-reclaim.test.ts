import { expect, it } from "vitest";
import { ConversationRoom } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const turn = { turnId: "t1", leaseId: "l1" };

function room() {
	const state = durableObjectState();
	const schedules: (number | null)[] = [];
	const conversation = new ConversationRoom(
		state.ctx as never,
		async (at: number | null) => {
			schedules.push(at);
		},
	);
	return { conversation, storage: state.ctx.storage, schedules };
}

it("re-takes a lapsed lease for the same turn after a restart", async () => {
	const { conversation, storage, schedules } = room();
	await storage.put("identity", { userId: "u", sessionId: "s" });
	await storage.put("active-turn", {
		userId: "u",
		sessionId: "s",
		...turn,
		expiresAt: 0,
		cancelled: false,
	});
	await storage.put("retired-turns", { t1: Date.now() + 60_000 });
	expect(await conversation.reclaim({ ...turn, leaseId: "rotated" })).toBe(
		true,
	);
	expect(await storage.get("retired-turns")).toEqual({});
	expect(await storage.get("active-turn")).toMatchObject({
		turnId: "t1",
		leaseId: "rotated",
		cancelled: false,
	});
	expect(schedules.at(-1)).toBeGreaterThan(Date.now());
});

it("keeps a cancelled turn stopped and never displaces a live newer turn", async () => {
	const { conversation, storage } = room();
	await storage.put("identity", { userId: "u", sessionId: "s" });
	await storage.put("active-turn", {
		userId: "u",
		sessionId: "s",
		...turn,
		expiresAt: 0,
		cancelled: true,
	});
	expect(await conversation.reclaim(turn)).toBe(false);
	await storage.put("active-turn", {
		userId: "u",
		sessionId: "s",
		turnId: "t2",
		leaseId: "l2",
		expiresAt: Date.now() + 30_000,
		cancelled: false,
	});
	expect(await conversation.reclaim(turn)).toBe(false);
});
