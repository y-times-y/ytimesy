import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	applyConversationDelta,
	type ConversationSnapshot,
	type ConversationUpdate,
	isConversationDelta,
} from "#/domain/conversation-delivery";
import {
	claimConversationDeliveries,
	conversationSnapshot,
	conversationUpdateSince,
	settleConversationDelivery,
} from "./conversation-delivery";

/**
 * The delivery claim against a real Postgres (PGlite) with the real
 * migrations: what it reads for a delta, and that a room merging the deltas
 * always holds what a full snapshot would show.
 */
const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());`);
	for (const file of [
		"20261001120000_conversation_delivery",
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
		"20261105100000_agent_session_items_rev",
		"20261114120000_conversation_delivery_items_rev",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	await db.exec("alter table agent_peer_inbox add column queued_send jsonb");
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
}, 60_000);
afterEach(() => db.close());

type Stored = { kind: string; id: string; text: string };
const user = (id: string): Stored => ({ kind: "userMessage", id, text: id });
const agent = (id: string, text = id): Stored => ({
	kind: "agentMessage",
	id,
	text,
});
/** An agent's internal report: stored, but the view drops it. */
const internal = (id: string): Stored =>
	agent(
		id,
		`agent ${id} finished. Its final summary is below:\n\ndone\n\nInspect its evidence and diff before accepting or publishing the result.`,
	);

async function chat(items: Stored[]) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,title,items,turn_status) values($1,'alice','codex','chat',$2::jsonb,'running')",
		[id, JSON.stringify(items)],
	);
	return id;
}
const write = (id: string, items: Stored[]) =>
	db.query("update agent_session set items=$2::jsonb where id=$1", [
		id,
		JSON.stringify(items),
	]);
async function claim() {
	const [delivery] = await claimConversationDeliveries(1);
	if (!delivery) throw new Error("Nothing to deliver");
	return delivery;
}
const bytes = (update: ConversationUpdate) =>
	Buffer.byteLength(JSON.stringify(update));

/** What a room does with an update: a full snapshot replaces, a delta merges (null: it asks for a full one). */
function receive(
	room: ConversationSnapshot,
	update: ConversationUpdate,
): ConversationSnapshot | null {
	if (!isConversationDelta(update)) return update;
	const merged = applyConversationDelta(room, update);
	return merged && { ...room, revision: update.revision, ...merged };
}

it("sends a full snapshot first, then only the rows written since the room's revision", async () => {
	const id = await chat([user("u1"), agent("a1"), internal("r1"), agent("a2")]);
	const first = await claim();
	expect(isConversationDelta(first.update)).toBe(false);
	const room = first.update as ConversationSnapshot;
	expect(room.window).toEqual({
		itemsRev: "0",
		first: 0,
		end: 4,
		hidden: [2],
	});
	await settleConversationDelivery(first, true);

	// One edited row and one new row.
	await write(id, [
		user("u1"),
		agent("a1"),
		internal("r1"),
		agent("a2", "a2 edited"),
		agent("a3"),
	]);
	const next = await claim();
	if (!isConversationDelta(next.update)) throw new Error("Expected a delta");
	expect(next.update.baseItemsRev).toBe("0");
	expect(next.update.rows).toEqual([
		{ position: 3, item: agent("a2", "a2 edited") },
		{ position: 4, item: agent("a3") },
	]);
	const merged = receive(room, next.update);
	const full = await conversationSnapshot("alice", id);
	expect(merged?.progress).toEqual(full?.progress);
	expect(merged?.window).toEqual(full?.window);
});

it("carries a removal as the new end, and a status change with no rows", async () => {
	const id = await chat([user("u1"), agent("a1"), agent("a2"), agent("a3")]);
	const first = await claim();
	let room = first.update as ConversationSnapshot;
	await settleConversationDelivery(first, true);

	await write(id, [user("u1"), agent("a1")]);
	const truncated = await claim();
	if (!isConversationDelta(truncated.update))
		throw new Error("Expected a delta");
	expect(truncated.update.rows).toEqual([]);
	expect(truncated.update.window.end).toBe(2);
	room = receive(room, truncated.update) as ConversationSnapshot;
	expect(room.progress.items.map((item) => (item as Stored).id)).toEqual([
		"u1",
		"a1",
	]);
	await settleConversationDelivery(truncated, true);

	await db.query(
		"update agent_session set turn_status='completed' where id=$1",
		[id],
	);
	const status = await claim();
	if (!isConversationDelta(status.update)) throw new Error("Expected a delta");
	expect(status.update.rows).toEqual([]);
	room = receive(room, status.update) as ConversationSnapshot;
	expect(room.progress).toEqual(
		(await conversationSnapshot("alice", id))?.progress,
	);
});

it("a delivery the room did not take leaves the base where the room is", async () => {
	const id = await chat([user("u1"), agent("a1")]);
	const first = await claim();
	const room = first.update as ConversationSnapshot;
	await settleConversationDelivery(first, true);
	await write(id, [user("u1"), agent("a1"), agent("a2")]);
	const lost = await claim();
	await settleConversationDelivery(lost, false);
	await db.query("update conversation_delivery set retry_at=now()");
	await write(id, [user("u1"), agent("a1"), agent("a2"), agent("a3")]);
	const retry = await claim();
	if (!isConversationDelta(retry.update)) throw new Error("Expected a delta");
	// Both new rows: the base is still the room's.
	expect(retry.update.rows.map((row) => row.position)).toEqual([2, 3]);
	expect(receive(room, retry.update)?.progress).toEqual(
		(await conversationSnapshot("alice", id))?.progress,
	);
});

it("reads the whole page for an unknown base, or one newer than the chat", async () => {
	const id = await chat([user("u1"), agent("a1")]);
	await write(id, [user("u1"), agent("a1"), agent("a2")]);
	expect(isConversationDelta((await claim()).update)).toBe(false);
	expect(
		isConversationDelta(
			(await conversationUpdateSince("alice", id, "99")) as ConversationUpdate,
		),
	).toBe(false);
	expect(await conversationUpdateSince("bob", id, "0")).toBeNull();
});

it("a delta during a long turn is the size of the changed item, not the page", async () => {
	const output = "x".repeat(2_000);
	const page = [
		user("u1"),
		...Array.from({ length: 90 }, (_, n) => agent(`t${n}`, output)),
	];
	const id = await chat(page);
	const first = await claim();
	await settleConversationDelivery(first, true);
	await write(id, [...page, agent("t90", "a small new step")]);
	const next = await claim();
	expect(isConversationDelta(next.update)).toBe(true);
	expect(bytes(first.update)).toBeGreaterThan(150_000);
	expect(bytes(next.update)).toBeLessThan(1_000);
});

it("over many random writes, the merged copy always equals a full snapshot, or asks for one", async () => {
	let seed = 7;
	const random = (n: number) => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed % n;
	};
	let items: Stored[] = [user("u0"), agent("a0")];
	const id = await chat(items);
	const first = await claim();
	let room = first.update as ConversationSnapshot;
	await settleConversationDelivery(first, true);
	let next = 1;
	let resyncs = 0;
	let deltas = 0;
	for (let step = 0; step < 60; step++) {
		const writes = 1 + random(3);
		for (let w = 0; w < writes; w++) {
			const action = random(10);
			if (action < 4) items = [...items, agent(`a${next++}`)];
			else if (action < 5) items = [...items, user(`u${next++}`)];
			else if (action < 6) items = [...items, internal(`r${next++}`)];
			else if (action < 8 && items.length > 1) {
				const at = random(items.length);
				items = items.map((item, index) =>
					index === at && item.kind === "agentMessage"
						? agent(item.id, `${item.text}+`)
						: item,
				);
			} else if (items.length > 3)
				items = items.slice(0, items.length - 1 - random(2));
			await write(id, items);
		}
		const delivery = await claim();
		const taken = random(5) > 0;
		let merged = receive(room, delivery.update);
		if (isConversationDelta(delivery.update)) deltas++;
		if (!merged) {
			// The room asks again: the job sends the full snapshot.
			resyncs++;
			merged = await conversationSnapshot("alice", id);
			delivery.update = merged as ConversationSnapshot;
		}
		const full = await conversationSnapshot("alice", id);
		expect(merged?.progress).toEqual(full?.progress);
		expect(merged?.window).toEqual(full?.window);
		if (taken && merged) room = merged;
		await settleConversationDelivery(delivery, taken);
		await db.query("update conversation_delivery set retry_at=now()");
	}
	expect(deltas).toBeGreaterThan(40);
	expect(resyncs).toBeLessThan(10);
});
