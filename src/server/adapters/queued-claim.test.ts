import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import {
	QUEUED_CLAIM_TTL_MS,
	type QueuedUserSend,
	queuedUserMessageItems,
	queueUserMessageWhileRunning,
	restoreQueuedUserMessages,
	takeNextQueuedUserMessages,
} from "./queued-user-messages";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));

let db: PGlite;
let chat: string;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,items jsonb not null default '[]',turn_status text default 'idle');
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default clock_timestamp());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	chat = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,turn_status) values($1,'alice','running')",
		[chat],
	);
});
afterEach(() => db.close());

const send = (text: string, released = false): QueuedUserSend => ({
	item: { kind: "userMessage", id: SessionItemId(randomUUID()), text },
	message: text,
	harnessId: "api",
	modelId: "connection|model",
	released,
});
const idle = () =>
	db.query("update agent_session set turn_status='idle' where id=$1", [chat]);
const running = () =>
	db.query("update agent_session set turn_status='running' where id=$1", [
		chat,
	]);
const rows = async () =>
	(await db.query<{ id: string }>("select id from agent_peer_inbox")).rows;
const lapse = () =>
	db.query(
		`update agent_peer_inbox set queued_send=jsonb_set(queued_send,'{claimedAt}',to_jsonb((extract(epoch from now())*1000)::bigint - ${QUEUED_CLAIM_TTL_MS + 1000}))`,
	);

// 2026-11-24, the Y² chat: a message queued while a wake ran was taken at the
// wake's end (its row deleted), and the delivery died before the turn existed
// (a deploy, a memory reset of the chat's object): the message was gone.
it("keeps a taken message in the chat until its turn exists, so a delivery that dies loses nothing", async () => {
	const lost = send("which threads can be removed");
	await queueUserMessageWhileRunning("alice", chat, lost);
	await idle();
	const taken = await takeNextQueuedUserMessages("alice", chat);
	expect(taken.map((row) => row.item.text)).toEqual([lost.item.text]);
	// The delivery dies here: nothing restores, nothing creates the turn.
	expect(await rows()).toHaveLength(1);
	expect(await queuedUserMessageItems(chat)).toEqual([
		expect.objectContaining({ id: lost.item.id }),
	]);
	// While the claim is live no other drain takes it or jumps ahead.
	expect(await takeNextQueuedUserMessages("alice", chat)).toEqual([]);
	// Once the claim lapses the next drain takes it again.
	await lapse();
	expect(
		(await takeNextQueuedUserMessages("alice", chat)).map(
			(row) => row.item.text,
		),
	).toEqual([lost.item.text]);
});

it("puts a message whose turn failed to start back where it was, ahead of later ones", async () => {
	const first = send("first");
	const second = send("second");
	await queueUserMessageWhileRunning("alice", chat, first);
	await queueUserMessageWhileRunning("alice", chat, second);
	await idle();
	const taken = await takeNextQueuedUserMessages("alice", chat, 1);
	expect(taken.map((row) => row.item.text)).toEqual(["first"]);
	await restoreQueuedUserMessages(chat, taken);
	expect(await rows()).toHaveLength(2);
	expect(
		(await takeNextQueuedUserMessages("alice", chat, 1)).map(
			(row) => row.item.text,
		),
	).toEqual(["first"]);
});

it("does not let a wake's turn starting in the gap lose the message: re-queued behind it, released, taken at its end", async () => {
	const mine = send("answer me first");
	await queueUserMessageWhileRunning("alice", chat, mine);
	await idle();
	const taken = await takeNextQueuedUserMessages("alice", chat);
	// A wake wins the race for the chat's turn; the delivery re-queues behind
	// it as the person's released message (user wins).
	await running();
	expect(
		await queueUserMessageWhileRunning("alice", chat, {
			...mine,
			released: true,
		}),
	).toBe("queued");
	expect(taken).toHaveLength(1);
	const [row] = (
		await db.query<{ queued_send: { released?: boolean; claimedAt?: number } }>(
			"select queued_send from agent_peer_inbox",
		)
	).rows;
	expect(row?.queued_send.released).toBe(true);
	expect(row?.queued_send.claimedAt).toBeUndefined();
	await idle();
	expect(
		(await takeNextQueuedUserMessages("alice", chat)).map((r) => r.item.text),
	).toEqual(["answer me first"]);
});

it("never hands the same message to two drains at once", async () => {
	await queueUserMessageWhileRunning("alice", chat, send("only one"));
	await idle();
	const both = await Promise.all([
		takeNextQueuedUserMessages("alice", chat),
		takeNextQueuedUserMessages("alice", chat),
	]);
	expect(both.flat()).toHaveLength(1);
});
