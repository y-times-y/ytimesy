import { expect, it } from "vitest";
import { ConversationRoom, isRealtimeRoute } from "../src/realtime/worker";
import { durableObjectState } from "./support/durable-object-state";

const userId = "alice";
const sessionId = "00000000-0000-4000-8000-000000000017";
const item = (id: string, text = id) => ({ kind: "agentMessage", id, text });

const full = (revision: string) => ({
	userId,
	sessionId,
	revision,
	progress: {
		sessionId,
		turnStatus: "running" as const,
		items: [item("a"), item("b")],
	},
	window: { itemsRev: "4", first: 0, end: 2, hidden: [] },
});
const delta = (revision: string, baseItemsRev = "4") => ({
	kind: "delta" as const,
	userId,
	sessionId,
	revision,
	baseItemsRev,
	window: { itemsRev: "5", first: 0, end: 3 },
	rows: [
		{ position: 1, item: item("b", "b edited") },
		{ position: 2, item: item("c") },
	],
	queued: [],
	hasOlderItems: false,
	turnStatus: "running" as const,
});
const stream = (deltas: boolean) =>
	`https://room/stream?${new URLSearchParams({ userId, sessionId, ...(deltas ? { deltas: "1" } : {}) })}`;

async function open(room: ConversationRoom, deltas: boolean) {
	const response = await room.fetch(new Request(stream(deltas)));
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	const decoder = new TextDecoder();
	const next = async () => decoder.decode((await reader.read()).value);
	return { next, close: () => reader.cancel() };
}
const data = (frame: string) => JSON.parse(frame.split("data: ")[1]);

it("sends a delta to viewers that merge them and the merged snapshot to older viewers", async () => {
	const room = new ConversationRoom(durableObjectState().ctx as never);
	expect((await room.publish(full("10"))).status).toBe(204);
	const merging = await open(room, true);
	const legacy = await open(room, false);
	try {
		// Each starts with the full snapshot.
		expect(await merging.next()).toContain("event: progress");
		expect(await legacy.next()).toContain("event: progress");
		expect((await room.publish(delta("11"))).status).toBe(204);
		const sent = await merging.next();
		expect(sent).toContain("event: delta");
		expect(data(sent).rows).toHaveLength(2);
		const old = await legacy.next();
		expect(old).toContain("event: progress");
		expect(data(old).items).toEqual([
			item("a"),
			item("b", "b edited"),
			item("c"),
		]);
	} finally {
		await merging.close();
		await legacy.close();
	}
	// The room keeps the merged snapshot for the next viewer.
	const later = await open(room, true);
	const first = data(await later.next());
	expect(first.items.map((entry: { id: string }) => entry.id)).toEqual([
		"a",
		"b",
		"c",
	]);
	expect(first.window).toEqual({ itemsRev: "5", first: 0, end: 3, hidden: [] });
	await later.close();
});

it("refuses a delta it cannot merge, so the publisher sends the full snapshot", async () => {
	const room = new ConversationRoom(durableObjectState().ctx as never);
	// No snapshot yet.
	expect((await room.publish(delta("11"))).status).toBe(409);
	await room.publish(full("10"));
	// Built against another revision (a delta this room missed).
	expect((await room.publish(delta("11", "3"))).status).toBe(409);
	// Older than what the room holds: nothing to do.
	expect((await room.publish(delta("9"))).status).toBe(204);
	// Another owner's.
	expect(
		(await room.publish({ ...delta("12"), userId: "mallory" })).status,
	).toBe(403);
	// Over HTTP, the same route.
	const response = await room.fetch(
		new Request("https://room/delta", {
			method: "POST",
			body: JSON.stringify(delta("11")),
		}),
	);
	expect(response.status).toBe(204);
	expect(isRealtimeRoute("/delta")).toBe(true);
});

it("a viewer takes a delta only against the snapshot it was last sent", async () => {
	const room = new ConversationRoom(durableObjectState().ctx as never);
	await room.publish(full("10"));
	const viewer = await open(room, true);
	await viewer.next();
	// A full snapshot the viewer gets, then a delta against it.
	await room.publish({ ...full("12"), window: { ...full("12").window } });
	expect(await viewer.next()).toContain("event: progress");
	await room.publish(delta("13"));
	expect(await viewer.next()).toContain("event: delta");
	await viewer.close();
});
