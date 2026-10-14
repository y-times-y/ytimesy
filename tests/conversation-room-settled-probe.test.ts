import { expect, it } from "vitest";
import { ConversationRoom } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const userId = "u";
const sessionId = "00000000-0000-4000-8000-000000000001";
const turn = {
	userId,
	sessionId,
	turnId: "00000000-0000-4000-8000-0000000000a1",
	leaseId: "00000000-0000-4000-8000-0000000000a2",
};
const probe = {
	userId,
	sessionId,
	turnId: "00000000-0000-4000-8000-0000000000b1",
	leaseId: "00000000-0000-4000-8000-0000000000b2",
};

function room() {
	const state = durableObjectState();
	const conversation = new ConversationRoom(state.ctx as never, async () => {});
	const control = async (action: string, body: object) =>
		(
			await conversation.fetch(
				new Request(`https://room/turn/${action}`, {
					method: "POST",
					body: JSON.stringify(body),
				}),
			)
		).status;
	return { conversation, control };
}

// Conversation restore probes the lease this way before rewinding code.
it("refuses a restore probe until a stopped turn's runner releases the lease", async () => {
	const { conversation, control } = room();
	expect(await control("acquire", turn)).toBe(204);
	expect(await control("cancel", turn)).toBe(204);
	expect(await control("acquire", probe)).toBe(409);
	expect(await control("release", turn)).toBe(204);
	expect(await control("acquire", probe)).toBe(204);
	// While the probe is held, a restarted runner cannot reclaim the old turn.
	expect(await conversation.reclaim(turn)).toBe(false);
	expect(await control("release", probe)).toBe(204);
	expect(
		await control("acquire", {
			...turn,
			turnId: "00000000-0000-4000-8000-0000000000c1",
		}),
	).toBe(204);
});
